import { config } from './config.js';
import { log } from './log.js';

/**
 * signal-cli-rest-api serialises every operation for an account behind a single
 * lock. A long-poll `receive` therefore blocks an outgoing `send` for the full
 * poll duration (measured: a 20s poll delayed a send by 22.7s).
 *
 * So all traffic to the API goes through one lane here, and interactive work
 * (sending, reacting, receipts) is queued at a higher priority than the receive
 * loop. Combined with a short receive timeout that caps send latency at roughly
 * one poll cycle (~3s) instead of a full poll window.
 */
const PRIORITY = { interactive: 0, normal: 1, background: 2 };

class Lane {
  #queue = [];
  #running = false;
  #seq = 0;

  run(task, { priority = 'normal', label = '' } = {}) {
    return new Promise((resolve, reject) => {
      this.#queue.push({
        task,
        resolve,
        reject,
        label,
        p: PRIORITY[priority] ?? PRIORITY.normal,
        seq: this.#seq++,
      });
      // Stable sort: priority first, then FIFO within a priority.
      this.#queue.sort((a, b) => a.p - b.p || a.seq - b.seq);
      this.#drain();
    });
  }

  get pendingInteractive() {
    return this.#queue.some((j) => j.p === PRIORITY.interactive);
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const job = this.#queue.shift();
        const started = Date.now();
        try {
          job.resolve(await job.task());
        } catch (err) {
          job.reject(err);
        }
        const ms = Date.now() - started;
        if (ms > 5000) log.debug(`lane: ${job.label || 'task'} took ${ms}ms`);
      }
    } finally {
      this.#running = false;
    }
  }
}

export const lane = new Lane();

export class SignalApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SignalApiError';
    this.status = status;
    this.body = body;
  }
}

/** Raw fetch against the REST API. Does NOT take the lane. */
async function raw(method, urlPath, { body, query, signal, timeoutMs = 60000, accept } = {}) {
  const url = new URL(config.apiUrl + urlPath);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: accept || 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });

    if (accept && accept !== 'application/json') {
      if (!res.ok) {
        throw new SignalApiError(`${method} ${urlPath} -> ${res.status}`, res.status, await res.text());
      }
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      };
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : text;
      throw new SignalApiError(`${method} ${urlPath} -> ${res.status}: ${detail}`, res.status, parsed);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const q = (method, urlPath, opts = {}, priority = 'normal') =>
  lane.run(() => raw(method, urlPath, opts), { priority, label: `${method} ${urlPath}` });

const enc = encodeURIComponent;

export const api = {
  lane,
  raw,

  about: () => raw('GET', '/v1/about', { timeoutMs: 10000 }),
  health: () => raw('GET', '/v1/health', { timeoutMs: 10000 }),
  accounts: () => raw('GET', '/v1/accounts', { timeoutMs: 15000 }),

  /**
   * Blocking receive. Runs at background priority so a queued send preempts it.
   * The caller owns the timeout budget: signal-cli adds ~2s of process startup
   * on top of `timeout` in native mode.
   */
  receive: (number, { timeout = 1, signal } = {}) =>
    lane.run(
      () =>
        raw('GET', `/v1/receive/${enc(number)}`, {
          query: {
            timeout,
            ignore_stories: 'true',
            send_read_receipts: 'false',
          },
          signal,
          timeoutMs: (timeout + 45) * 1000,
        }),
      { priority: 'background', label: 'receive' }
    ),

  send: (payload) =>
    q('POST', '/v2/send', { body: payload, timeoutMs: 180000 }, 'interactive'),

  react: (number, body) =>
    q('POST', `/v1/reactions/${enc(number)}`, { body }, 'interactive'),

  unreact: (number, body) =>
    q('DELETE', `/v1/reactions/${enc(number)}`, { body }, 'interactive'),

  // Deliberately below 'interactive': marking a busy group read can queue
  // dozens of these, and a message you type next must not wait behind them.
  receipt: (number, body) =>
    q('POST', `/v1/receipts/${enc(number)}`, { body }, 'normal'),

  /** "Delete for everyone" — retracts a message you sent, on every device. */
  remoteDelete: (number, body) =>
    q('DELETE', `/v1/remote-delete/${enc(number)}`, { body }, 'interactive'),

  startTyping: (number, body) =>
    q('PUT', `/v1/typing-indicator/${enc(number)}`, { body }, 'interactive'),

  stopTyping: (number, body) =>
    q('DELETE', `/v1/typing-indicator/${enc(number)}`, { body }, 'interactive'),

  contacts: (number) =>
    q('GET', `/v1/contacts/${enc(number)}`, { query: { all_recipients: 'true' } }, 'normal'),

  groups: (number) => q('GET', `/v1/groups/${enc(number)}`, {}, 'normal'),

  attachment: (id) =>
    q('GET', `/v1/attachments/${enc(id)}`, { accept: 'application/octet-stream' }, 'normal'),

  contactAvatar: (number, uuid) =>
    q(
      'GET',
      `/v1/contacts/${enc(number)}/${enc(uuid)}/avatar`,
      { accept: 'application/octet-stream' },
      'background'
    ),

  groupAvatar: (number, groupId) =>
    q(
      'GET',
      `/v1/groups/${enc(number)}/${enc(groupId)}/avatar`,
      { accept: 'application/octet-stream' },
      'background'
    ),

  createGroup: (number, body) => q('POST', `/v1/groups/${enc(number)}`, { body }, 'interactive'),

  /** Leave a group, notifying the other members. */
  quitGroup: (number, groupId) =>
    q('POST', `/v1/groups/${enc(number)}/${enc(groupId)}/quit`, {}, 'interactive'),

  /** Drop signal-cli's own record of the group, so it stops coming back. */
  deleteGroup: (number, groupId) =>
    q('DELETE', `/v1/groups/${enc(number)}/${enc(groupId)}`, {}, 'interactive'),

  updateContact: (number, body) => q('PUT', `/v1/contacts/${enc(number)}`, { body }, 'interactive'),

  search: (number, numbers) =>
    q('GET', `/v1/search/${enc(number)}`, { query: { numbers } }, 'interactive'),
};

/** True when an interactive job is waiting — the receive loop yields on this. */
export const hasInteractiveWork = () => lane.pendingInteractive;
