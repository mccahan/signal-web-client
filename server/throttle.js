import { config } from './config.js';
import { log } from './log.js';

/**
 * Outbound rate limiting.
 *
 * This is a safety net, not an access control — `requireAuth` is what keeps
 * strangers out. What this protects against is the case where something with a
 * valid session misbehaves: a runaway client loop, a stuck retry, a script
 * someone points at the API. The cost of that lands on the *Signal account*,
 * which is shared, remote, and not ours to rate-limit — Signal will happily
 * throttle or flag an account that starts behaving like a spam source, and
 * getting one un-flagged is not something this app can do for you.
 *
 * The limit is therefore **global, not per-session or per-IP**. Every browser
 * signed in here drives one upstream account, so keying on the caller would let
 * N devices multiply the exact load we are trying to bound. Two phones logged in
 * as you are still just you.
 *
 * Token bucket rather than a fixed window: sending a short flurry of messages is
 * completely normal (pasting a few lines, replying to a backlog), whereas a
 * *sustained* stream at that rate is not. A fixed window either rejects the
 * normal burst or permits the sustained flood, depending on where the boundary
 * lands; a bucket allows the burst and then settles to the sustained rate.
 */

/**
 * @param capacity      burst size — how many can go out back to back
 * @param refillPerMin  sustained rate once the burst is spent; 0 disables
 */
export function createTokenBucket({ capacity, refillPerMin }) {
  const enabled = refillPerMin > 0 && capacity > 0;
  let tokens = capacity;
  // performance.now() rather than Date.now(): monotonic, so an NTP correction
  // or a DST-adjacent clock jump can't hand out a windfall of tokens or freeze
  // the bucket for hours.
  let last = performance.now();

  function refill() {
    const now = performance.now();
    const elapsedMin = (now - last) / 60000;
    last = now;
    tokens = Math.min(capacity, tokens + elapsedMin * refillPerMin);
  }

  return {
    get enabled() {
      return enabled;
    },

    /**
     * Spend a token if one is available.
     * @returns {{ok: true}|{ok: false, retryAfterMs: number}}
     */
    take() {
      if (!enabled) return { ok: true };
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return { ok: true };
      }
      // Time until the bucket is back above one whole token.
      const retryAfterMs = Math.ceil(((1 - tokens) / refillPerMin) * 60000);
      return { ok: false, retryAfterMs };
    },
  };
}

/**
 * The bucket every outbound Signal message shares.
 *
 * Reactions and remote deletes count against it too — they are all messages on
 * the wire as far as Signal is concerned, and a reaction loop would look
 * exactly as much like abuse as a text loop.
 *
 * Deliberately *not* covered:
 *
 * - **Typing indicators.** They are high-frequency by design and already
 *   fire-and-forget; a limit low enough to matter would break the feature, and
 *   a stray one costs a recipient nothing.
 * - **Read receipts.** Already bounded by MAX_RECEIPTS_PER_READ, and they run
 *   at `normal` priority so they can't crowd out a send.
 */
export const sendLimiter = createTokenBucket({
  capacity: config.sendBurst,
  refillPerMin: config.sendRatePerMinute,
});

let lastWarnAt = 0;

/**
 * Claim capacity for one outbound message, or throw a 429.
 *
 * Callers must invoke this *before* any side effect — `sendMessage` writes an
 * optimistic row and publishes it to every open browser before the API call, so
 * throttling any later than that would leave a bubble on screen for a message
 * that was never sent.
 *
 * Rejecting beats queueing here. A delayed send is indistinguishable from a slow
 * one, so a runaway loop would silently pile up behind the lane and look like
 * the app being sluggish; a 429 surfaces in the composer, where whoever is
 * looking at it can act on it.
 */
export function claimSend(kind = 'message') {
  const result = sendLimiter.take();
  if (result.ok) return;

  const seconds = Math.ceil(result.retryAfterMs / 1000);

  // Log at most once a minute: whatever tripped this is by definition sending
  // in a loop, and a log line per attempt would just be more of the same flood.
  const now = Date.now();
  if (now - lastWarnAt > 60000) {
    lastWarnAt = now;
    log.warn(
      `outbound rate limit hit (${kind}); allowing ${config.sendRatePerMinute}/min ` +
        `with a burst of ${config.sendBurst}. Raise SEND_RATE_PER_MINUTE if this is legitimate.`
    );
  }

  throw Object.assign(
    new Error(`Sending too fast — try again in ${seconds}s`),
    { status: 429, retryAfterSeconds: seconds }
  );
}
