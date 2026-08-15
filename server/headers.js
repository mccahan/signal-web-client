import { config } from './config.js';

/**
 * Security response headers.
 *
 * The policy can be strict because the front end has no build step and no
 * external anything: `public/index.html` carries a single `<script src>`, no
 * inline `<script>`, no inline `<style>`, no `on*` attributes, and nothing is
 * loaded from a CDN. So `script-src 'self'` needs no `'unsafe-inline'` and no
 * nonce plumbing — which is the property worth protecting when editing the
 * front end. Adding one inline handler would force `'unsafe-inline'` and undo
 * most of the value here; build the node and attach a listener instead.
 *
 * Deliberately absent:
 *
 * - **`upgrade-insecure-requests`.** The app is normally reached over plain
 *   HTTP at a LAN address. This would rewrite those requests to https:// and
 *   break it completely.
 * - **`require-trusted-types-for`.** The icon helper assigns static SVG markup
 *   through innerHTML, which Trusted Types would reject.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Nothing here is ever meant to be framed; frame-ancestors is the modern
  // spelling and X-Frame-Options below covers browsers that predate it.
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: is for the composer's local image previews (URL.createObjectURL).
  // Attachments themselves are same-origin, served through /api/attachments.
  "img-src 'self' blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  // 'self' covers the WebSocket too: ws:// to the same host and port matches
  // the document's origin under CSP 3. Verified in a browser rather than
  // assumed — getting this wrong silently kills live message delivery.
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

const PERMISSIONS = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');
// autoplay and encrypted-media are left alone: attachment playback is
// user-initiated, and restricting them buys nothing while risking the players.

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Conversation URLs are not secret, but a message can contain a link the
  // recipient clicks; no-referrer keeps this server's LAN address out of the
  // request that follows.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', PERMISSIONS);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  // HSTS only where TLS is actually in use. SECURE_COOKIE is already the
  // "this is served over HTTPS" switch, so it decides this too rather than
  // adding a second knob that can disagree with the first.
  //
  // No includeSubDomains and no preload, both deliberate: this typically runs
  // on a LAN hostname whose siblings are other services, and committing them
  // all to HTTPS from here would take them down. Nothing on the wire can undo
  // an HSTS header for the length of its max-age.
  if (config.secureCookie) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  next();
}

/**
 * Header overrides for a served attachment.
 *
 * The Content-Type on these responses comes from whoever sent the file. The UI
 * only ever links them with ?download=1, which forces a download, and images
 * and video load as subresources where a CSP sandbox does not apply — but
 * `/api/attachments/<id>` fetched directly still renders inline on this
 * origin, and "inline" for a text/html attachment would mean someone else's
 * markup running as a same-origin document.
 *
 * `sandbox` drops that document into a unique opaque origin with scripts
 * disabled, which is what makes serving other people's files from the same
 * origin survivable. This is the same approach GitHub uses for user content.
 */
export function attachmentHeaders(res) {
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
