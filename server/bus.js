import { EventEmitter } from 'node:events';

/**
 * Fan-out point between the receive loop / REST handlers and every connected
 * browser. Handlers push `{type, ...payload}` objects; the WebSocket layer
 * serialises them straight through.
 */
class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    this.clientCount = 0;
    // Live browser sockets. Held here rather than in index.js so the routes can
    // report presence without importing the server (which imports the routes).
    this.sockets = new Set();
  }

  /** Currently-connected browsers, for the sessions list. */
  presence() {
    return [...this.sockets].map((ws) => ({
      sessionId: ws.sessionId || null,
      userAgent: ws.userAgent || '',
      ip: ws.ip || '',
      connectedAt: ws.connectedAt || 0,
    }));
  }

  publish(type, payload = {}) {
    this.emit('event', { type, ...payload });
  }

  subscribe(fn) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
