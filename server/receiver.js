import WebSocket from 'ws';
import { config } from './config.js';
import { log } from './log.js';
import { api, hasInteractiveWork } from './signal-api.js';
import { ingestBatch, ingestEnvelope } from './ingest.js';
import { bus } from './bus.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const state = {
  mode: 'unknown',      // 'native' | 'normal' | 'json-rpc' | 'json-rpc-native'
  transport: 'idle',    // 'polling' | 'websocket'
  connected: false,
  lastReceiveAt: 0,
  lastErrorAt: 0,
  lastError: '',
  consecutiveErrors: 0,
};

function setConnected(connected, error) {
  const changed = state.connected !== connected;
  state.connected = connected;
  if (error) {
    state.lastError = error;
    state.lastErrorAt = Date.now();
  }
  if (changed) {
    log[connected ? 'info' : 'warn'](
      `signal link ${connected ? 'up' : 'down'}${error ? ` (${error})` : ''}`
    );
    bus.publish('status', publicStatus());
  }
}

export function publicStatus() {
  return {
    connected: state.connected,
    mode: state.mode,
    transport: state.transport,
    lastReceiveAt: state.lastReceiveAt,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  };
}

// ---------------------------------------------------------------------------
// json-rpc mode: /v1/receive upgrades to a WebSocket that streams envelopes.
// ---------------------------------------------------------------------------
function startWebsocketReceiver(number, { onFallback }) {
  const url =
    config.apiUrl.replace(/^http/, 'ws') + `/v1/receive/${encodeURIComponent(number)}`;
  let ws;
  let retry = 1000;
  let stopped = false;
  let heartbeat;

  const connect = () => {
    if (stopped) return;
    log.info(`connecting to receive stream ${url}`);
    ws = new WebSocket(url, { handshakeTimeout: 15000 });

    ws.on('open', () => {
      retry = 1000;
      // Reset here too, or three abnormal disconnects spread over days (a 1006
      // is the normal code for an API restart) permanently demote a healthy
      // json-rpc deployment to polling.
      state.consecutiveErrors = 0;
      state.transport = 'websocket';
      setConnected(true);
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30000);
    });

    ws.on('message', (raw) => {
      state.lastReceiveAt = Date.now();
      const text = raw.toString('utf8').trim();
      if (!text) return;
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) ingestBatch(parsed);
        else ingestEnvelope(parsed);
      } catch (err) {
        log.warn('unparsable frame from receive stream:', err.message);
      }
    });

    ws.on('error', (err) => {
      setConnected(false, err.message);
    });

    ws.on('close', (code) => {
      clearInterval(heartbeat);
      setConnected(false, `stream closed (${code})`);
      if (stopped) return;
      // 404/400 on upgrade means this build isn't in json-rpc mode after all.
      if (code === 1002 || code === 1006) {
        state.consecutiveErrors++;
        if (state.consecutiveErrors >= 3) {
          log.warn('receive stream unavailable, falling back to polling');
          stopped = true;
          onFallback();
          return;
        }
      }
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    });
  };

  connect();
  return () => {
    stopped = true;
    clearInterval(heartbeat);
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  };
}

// ---------------------------------------------------------------------------
// native / normal mode: repeated short blocking polls.
//
// Every call costs ~2s of signal-cli startup and holds the account's only lock,
// so we keep the poll window short and skip straight to the next cycle whenever
// a send is waiting.
// ---------------------------------------------------------------------------
function startPollingReceiver(number) {
  let stopped = false;
  state.transport = 'polling';

  (async () => {
    while (!stopped) {
      const idle = bus.clientCount === 0;
      const timeout = idle ? config.idleReceiveTimeout : config.receiveTimeout;

      try {
        const batch = await api.receive(number, { timeout });
        state.lastReceiveAt = Date.now();
        state.consecutiveErrors = 0;
        setConnected(true);

        if (Array.isArray(batch) && batch.length) {
          const n = ingestBatch(batch);
          log.debug(`ingested ${n} envelope(s)`);
        }
      } catch (err) {
        state.consecutiveErrors++;
        setConnected(false, err.message);
        // Back off gently; the API may just be restarting signal-cli.
        const wait = Math.min(2000 * state.consecutiveErrors, 30000);
        log.warn(`receive failed (${err.message}); retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }

      // Yield the lane immediately if someone is trying to send.
      if (hasInteractiveWork()) continue;
      if (idle) await sleep(config.idlePollGap);
    }
  })();

  return () => {
    stopped = true;
  };
}

export async function startReceiver(number) {
  let stop = () => {};

  try {
    const about = await api.about();
    state.mode = about?.mode || 'unknown';
    log.info(`signal-cli-rest-api ${about?.version || '?'} in "${state.mode}" mode`);
  } catch (err) {
    log.warn(`could not read /v1/about: ${err.message}`);
  }

  const usesJsonRpc = /json-rpc/.test(state.mode);

  if (usesJsonRpc) {
    log.info('json-rpc mode detected — using the live receive stream');
    stop = startWebsocketReceiver(number, {
      onFallback: () => {
        stop = startPollingReceiver(number);
      },
    });
  } else {
    log.info(
      `polling every ~${config.receiveTimeout + 2}s. ` +
        'Tip: run signal-cli-rest-api with MODE=json-rpc for instant delivery.'
    );
    stop = startPollingReceiver(number);
  }

  return () => stop();
}
