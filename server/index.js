import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { log } from './log.js';
import { api } from './signal-api.js';
import { bus } from './bus.js';
import { router as apiRouter } from './routes/api.js';
import { startReceiver, publicStatus } from './receiver.js';
import { startRosterLoop, resolveSelfIdentity } from './roster.js';
import { startBackupLoop } from './backup.js';
import { setSelf, self, listConversations } from './store.js';
import { isAuthed, authEnabled } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Base64 attachments inflate ~33%, so the JSON limit tracks the upload cap.
app.use(express.json({ limit: Math.ceil(config.maxUploadBytes * 1.4) }));

app.use('/api', apiRouter);

app.use(
  express.static(publicDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      // The shell and service worker must never be served stale.
      if (/(index\.html|sw\.js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// SPA fallback for anything that isn't an API call.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket fan-out to browsers
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  bus.clientCount = wss.clients.size;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // Prime the client with everything it needs to render immediately.
  send({
    type: 'hello',
    me: { number: self.number, uuid: self.uuid, contactId: self.contactId },
    status: publicStatus(),
    conversations: listConversations(),
  });

  const unsubscribe = bus.subscribe(send);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') send({ type: 'pong', t: msg.t });
    } catch {
      /* ignore malformed client frames */
    }
  });

  ws.on('close', () => {
    unsubscribe();
    bus.clientCount = wss.clients.size;
  });

  ws.on('error', (err) => log.debug(`ws client error: ${err.message}`));
});

// Drop half-open sockets (common when a phone sleeps or changes network).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  bus.clientCount = wss.clients.size;
}, 30000);
heartbeat.unref?.();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function resolveAccount() {
  if (config.number) return config.number;
  log.info('SIGNAL_NUMBER not set — asking the API which accounts are linked');
  const accounts = await api.accounts();
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error(
      'No accounts registered with signal-cli-rest-api. Link or register one first.'
    );
  }
  if (accounts.length > 1) {
    log.warn(`multiple accounts found (${accounts.join(', ')}); using the first. Set SIGNAL_NUMBER to choose.`);
  }
  return accounts[0];
}

/**
 * Attach to the Signal account, retrying until the upstream API answers.
 *
 * This deliberately runs *after* the web server is listening: if the API is
 * down or still booting, the UI should still load and show a disconnected
 * state rather than leaving the port dead.
 */
async function connectSignal() {
  for (let attempt = 1; ; attempt++) {
    try {
      await api.health();

      const number = await resolveAccount();
      const uuid = await resolveSelfIdentity(number);
      setSelf({ number, uuid });
      log.info(`using account ${number}${uuid ? ` (${uuid})` : ''}`);
      // Browsers that connected before the link came up are still showing a
      // blank account; tell them who we are.
      bus.publish('me', { me: { number: self.number, uuid: self.uuid, contactId: self.contactId } });

      startRosterLoop();
      await startReceiver(number);
      return;
    } catch (err) {
      const wait = Math.min(2000 * attempt, 30000);
      log.warn(
        `cannot reach signal-cli-rest-api at ${config.apiUrl} (${err.message}); retrying in ${wait / 1000}s`
      );
      bus.publish('status', { connected: false, lastError: err.message, transport: 'idle' });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  log.info(`signal-web-client starting; API at ${config.apiUrl}`);

  await new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      log.info(`listening on http://${config.host}:${config.port}`);
      if (!authEnabled) {
        log.warn(
          'AUTH_PASSWORD is not set — anyone who can reach this port can read and send your messages'
        );
      }
      resolve();
    });
  });

  // Independent of the Signal link: history is worth protecting even while the
  // upstream API is unreachable.
  startBackupLoop();

  connectSignal();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info(`${sig} received, shutting down`);
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

// A messaging client that dies on a stray I/O error is worse than one that
// logs and keeps serving; the receive loop and WebSockets stay up.
process.on('uncaughtException', (err) => log.error('uncaught exception:', err));

main().catch((err) => {
  log.error('fatal:', err);
  process.exit(1);
});
