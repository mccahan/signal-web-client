/** Thin fetch wrapper. Throws `Error` with `.status` so callers can branch. */
async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  getSession: () => request('GET', '/api/session'),
  login: (password) => request('POST', '/api/session', { password }),
  logout: () => request('DELETE', '/api/session'),

  me: () => request('GET', '/api/me'),
  conversations: (refresh) => request('GET', `/api/conversations${refresh ? '?refresh=1' : ''}`),
  messages: (id, { before, limit = 50 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set('before', String(before));
    return request('GET', `/api/conversations/${encodeURIComponent(id)}/messages?${qs}`);
  },
  send: (id, payload) =>
    request('POST', `/api/conversations/${encodeURIComponent(id)}/messages`, payload),
  markRead: (id) => request('POST', `/api/conversations/${encodeURIComponent(id)}/read`, {}),
  typing: (id, started) =>
    request('POST', `/api/conversations/${encodeURIComponent(id)}/typing`, { started }),
  react: (id, payload) =>
    request('POST', `/api/conversations/${encodeURIComponent(id)}/reactions`, payload),
  hideMessage: (id, ts, authorId) =>
    request(
      'DELETE',
      `/api/conversations/${encodeURIComponent(id)}/messages/${ts}?authorId=${encodeURIComponent(authorId)}`
    ),
  /** Retract a message you sent, on every device that received it. */
  deleteForEveryone: (id, ts) =>
    request('DELETE', `/api/conversations/${encodeURIComponent(id)}/messages/${ts}?scope=everyone`),
  startConversation: (recipient) => request('POST', '/api/conversations', { recipient }),
  leaveGroup: (id) => request('POST', `/api/conversations/${encodeURIComponent(id)}/leave`, {}),
  deleteConversation: (id) => request('DELETE', `/api/conversations/${encodeURIComponent(id)}`),
  patchConversation: (id, patch) =>
    request('PATCH', `/api/conversations/${encodeURIComponent(id)}`, patch),
  search: (q) => request('GET', `/api/search?q=${encodeURIComponent(q)}`),
};

/**
 * Auto-reconnecting event stream. Falls back to exponential backoff and tells
 * the app about connection transitions so the UI can resync after a gap.
 */
export function connectStream({ onEvent, onOpen, onClose }) {
  let ws = null;
  let retry = 500;
  let closed = false;
  let pingTimer = null;
  let reconnectTimer = null;

  const open = () => {
    if (closed) return;
    // Cancel any pending retry, and never stack a second socket on top of one
    // that is already open or still connecting — duplicates would deliver
    // every server event twice and fight over the keepalive timer.
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws`);
    ws = sock;

    sock.onopen = () => {
      if (ws !== sock) return sock.close();
      retry = 500;
      onOpen?.();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'ping', t: Date.now() }));
        }
      }, 25000);
    };

    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // malformed frame — ignore it, but never swallow handler errors
      }
      onEvent(payload);
    };

    sock.onclose = () => {
      // A superseded socket must not touch shared timers or trigger a retry.
      if (ws !== sock) return;
      clearInterval(pingTimer);
      onClose?.();
      if (closed) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(open, retry);
      retry = Math.min(retry * 1.8, 15000);
    };

    sock.onerror = () => sock.close();
  };

  open();

  // A phone that wakes from sleep keeps a dead socket; nudge it awake.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      retry = 500;
      open();
    }
  });

  return {
    close() {
      closed = true;
      clearInterval(pingTimer);
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}

/** Read a File into the `data:<mime>;filename=<name>;base64,<data>` form. */
export function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const raw = String(reader.result);
      const base64 = raw.slice(raw.indexOf(',') + 1);
      const type = file.type || 'application/octet-stream';
      const name = file.name ? `filename=${file.name.replace(/[;,]/g, '_')};` : '';
      resolve(`data:${type};${name}base64,${base64}`);
    };
    reader.readAsDataURL(file);
  });
}
