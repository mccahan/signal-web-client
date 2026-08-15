# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # run the server (http://localhost:8080)
npm run dev        # same, with --watch
./scripts/smoke-test.sh <image>   # boot a built image and verify it works
npm run icons      # regenerate public/icons/* (rarely needed; PNGs are committed)

docker compose up -d --build
docker build -t signal-web-client . && docker run -p 8080:8080 \
  -e SIGNAL_API_URL=http://<host>:8095 -v signal-web-data:/data signal-web-client
```

Node 26+ is required (`nvm use 26`) — storage uses the built-in `node:sqlite`,
so there are no native modules. `node:sqlite` is **stable as of Node 26**; on
Node 24 and earlier it was experimental and warned on every start, which is why
older revisions of this repo passed `--no-warnings=ExperimentalWarning`. Do not
reintroduce that flag: it would also hide warnings for any *other* experimental
API someone adds later.

The frontend has **no build step**. `public/` is served as-is and the browser
loads the ES modules directly; editing `public/js/*.js` needs only a reload.

**There is no test framework, linter, or formatter configured.** Do not invent
an `npm test`. See *Verifying changes* below for how this codebase is actually
exercised.

## The two constraints that shaped everything

Both were measured against a live `signal-cli-rest-api`, not assumed. Understand
them before changing `signal-api.js`, `receiver.js`, or `outbound.js`.

**1. Receiving is destructive.** `GET /v1/receive` delivers each message exactly
once and stores nothing upstream. This app's SQLite database is therefore the
only copy of history, and it must be the sole consumer of that queue — two
instances polling one account split the message stream between their databases
and each silently misses what the other got.

**2. Every operation serialises per account.** signal-cli holds one lock per
account, so an in-flight long-poll `receive` blocks an outgoing `send` for the
entire poll window (measured: a 20s poll delayed a send by 22.7s).

So *all* upstream traffic goes through a single priority lane in
`server/signal-api.js`, with three tiers:

- `interactive` — sends, reactions, typing. Preempts everything.
- `normal` — read receipts, roster, attachments. Deliberately below sends: marking
  a busy group read can queue dozens of receipts, and a message typed next must
  not wait behind them.
- `background` — the receive loop, which yields as soon as interactive work queues.

The poll window is kept short (`RECEIVE_TIMEOUT`, default 1s) because each call
also costs ~2s of signal-cli startup. Net send latency is ~3s.

The in-flight receive is deliberately **never cancelled**: signal-cli removes
messages from the server queue as it reads them, so aborting the HTTP request
risks losing whatever it already consumed. That is why `IDLE_RECEIVE_TIMEOUT`
is modest rather than long.

**`json-rpc` mode changes all of this.** If the upstream container runs
`MODE=json-rpc`, signal-cli stays resident and `/v1/receive` becomes a live
WebSocket stream, removing the contention entirely. `receiver.js` detects the
mode from `/v1/about` at startup and picks the transport automatically, falling
back to polling if the stream can't be established.

## Data flow

```
browser ──REST──▶ routes/api.js ──▶ outbound.js ──┐
                                                  ├──▶ signal-api.js (one lane) ──▶ upstream
receiver.js ◀── poll or stream ───────────────────┘
     │
     └──▶ ingest.js ──▶ store.js (SQLite) ──▶ bus.js ──▶ WebSocket ──▶ browser
```

`bus.js` is the only path from server state to the browser. Anything that
changes a conversation or message must publish, or open clients go stale.
Events: `hello`, `me`, `status`, `conversations`, `conversation`,
`conversation_removed`, `message`, `message_update`, `message_removed`, `typing`.

Sends are optimistic **server-side**, not client-side: `outbound.sendMessage`
inserts a `pending` row and publishes it before calling upstream, so the bubble
appears over the WebSocket in milliseconds. The client does not draw its own
provisional bubble.

## Outbound rate limiting

`throttle.js` holds a token bucket that `sendMessage`, `sendReaction` and
`deleteForEveryone` each claim from. It is a backstop against a runaway client
or a stuck retry loop, not an access control — `requireAuth` is what keeps
strangers out. The thing at risk is the Signal *account*, which Signal will
throttle or flag if it starts behaving like a spam source.

Two properties are easy to break:

- **The bucket is global, not per-session or per-IP.** Every signed-in browser
  drives one upstream account, so keying it on the caller would let N devices
  multiply the exact load it exists to bound.
- **`claimSend` must run before the optimistic insert.** Everything after that
  point has already published a bubble to every open browser; throttling later
  would strand it on screen as a `pending` message that was never sent.

Typing indicators and read receipts are deliberately exempt — the first is
high-frequency by design, and the second is already bounded by
`MAX_RECEIPTS_PER_READ` and runs below sends on the lane.

## Identity rules (the source of most subtle bugs)

**Messages** are identified by `(conversation_id, ts, author_id)` — a UNIQUE
constraint — because that is how Signal itself identifies a message. This makes
ingest idempotent: replays and the sync echo of something we just sent collapse
onto one row. `insertMessage` checks for an existing row first so a re-ingest
does not re-increment the unread badge.

Outgoing messages get a **provisional timestamp** that is re-keyed to the real
Signal timestamp once `/v2/send` returns; receipts arriving later reference that
real value. The provisional timestamp is strictly monotonic — plain `Date.now()`
let two sends in the same millisecond collapse into one row and destroy the
first message's text.

**Contacts** arrive keyed sometimes by ACI (uuid) and sometimes by E.164.
`upsertContact` keys on the uuid when known and folds any number-keyed row into
it the moment both are seen together (`mergeContacts`), re-pointing messages,
reactions (**both** `author_id` and `target_author`), and the conversation.

**Groups have two ids and they are not interchangeable:**

| id | shape | used for |
| --- | --- | --- |
| `internal_id` | raw base64 | what inbound envelopes carry; our conversation key |
| `id` | `group.<base64>` | `/v2/send` recipients **and** all `/v1/groups/...` path params |

`POST /v1/groups` returns only the `group.` form, and path endpoints 404 on the
internal id. `ensureGroupConversation` recognises both and resolves them to one
row — without that, a group becomes two conversations.

**Conversation ids:** `dm:<uuid|e164>`, `group:<internalId>`. Note-to-Self is
type `self`.

**Read receipts go to the message's author, not the conversation.** In a DM
those coincide; in a group they do not, which is why `markRead` sends one
receipt per sender.

## Schema changes

`db.js` does not create tables. `server/migrations/` holds numbered migrations
that `migrate.js` applies at database-open time, before `store.js` prepares its
~46 module-scope statements — which is why `db.js` uses **top-level await**.
Removing that await would let statement preparation race the schema.

Add a change as the next-numbered `.sql` or `.mjs` file (see
`server/migrations/README.md`); never edit an applied one, since its checksum is
recorded and drift is reported at boot. Migrations run one transaction each and
abort the whole run on failure — the server refuses to start rather than serve
from a half-migrated database. An existing database is snapshotted to the
backups directory first. `GET /api/migrations` reports the current version.

## `node:sqlite` gotchas

- Double-quoted strings are parsed as **identifiers**. `WHERE x != ""` raises
  `no such column: ""`. Always single-quote literals in SQL.
- `undefined` bindings throw (`null` is fine). Guard values that may be absent
  before passing them to `.run()`/`.get()`.
- `.get()` returns `undefined`, not `null`, when there is no row.
- Rows have a null prototype; `store.js` normalises them via `plain`/`plainAll`.

## Behaviours that look like bugs but are deliberate

- **Deleting a conversation hides it rather than removing the row.** signal-cli
  keeps listing a group even after `DELETE /v1/groups` returns 200, so a deleted
  row would be recreated by the next roster sync. New incoming traffic un-hides
  the thread (`bumpActivity`), so a message can never arrive somewhere invisible.
- **Message status never moves backwards** (`updateMessageStatus` ranks
  `pending < sent < delivered < read`), including to `failed` — a timed-out HTTP
  call after the recipient already read the message means the response was lost,
  not the message.
- **Group update events re-sync the roster and diff membership** before writing
  their text, because the envelope says only "something changed" and carries no
  diff. That is how "X left the group" is distinguished from "X was removed".
- **The runtime base is a moving tag.** The image runs on Chainguard's Node
  base, whose free tier publishes only `:latest`, so CI smoke-tests the built
  image before publishing. If that step fails after a base bump, the base moved
  under us — check `node:sqlite` first.
- **Back up `data/backups/`, never `data/signal-web.db`.** The live database is
  WAL-mode; `backup.js` writes integrity-checked snapshots and keeps `latest.db`
  hard-linked to the newest.

## Browser-side constraints

The app is normally reached over plain HTTP at a LAN address, which is **not a
secure context**. `crypto.randomUUID`, `Notification` and similar are undefined
there — guard with `typeof`, never optional chaining (optional chaining does not
protect an undeclared global). `public/js/app.js` has a `newId()` fallback for
exactly this.

CSS carries a global `[hidden] { display: none !important }` because the
class-level `display` rules would otherwise beat the UA rule, and the UI toggles
visibility with the `hidden` attribute throughout.

`headers.js` sends a CSP with **no `'unsafe-inline'`**, which the front end can
afford only because `index.html` has no inline `<script>`, no inline `<style>`
and no `on*` attributes. Adding any one of them would force `'unsafe-inline'`
back into `script-src` or `style-src` and undo most of the policy — build the
node and attach a listener instead. Assigning `element.style.x` is CSSOM and
stays fine; `setAttribute('style', …)` does not.

Two directives are deliberately absent: `upgrade-insecure-requests` (the app is
normally plain HTTP on a LAN, and it would rewrite every request to https) and
`require-trusted-types-for` (the icon helper assigns static SVG via innerHTML).
`connect-src 'self'` covers the WebSocket — verified in a browser, since
getting it wrong kills live delivery silently rather than loudly.

Attachment responses override the policy with `Content-Security-Policy:
sandbox`, because their `Content-Type` comes from whoever sent the file and
`/api/attachments/<id>` fetched directly would otherwise render someone else's
markup as a same-origin document. The sandbox applies to navigation only, so
`<img>` and `<video>` still load from those URLs.

The service worker caches the app shell only — never messages or media, so that
stale or deleted content is never resurrected.

## Verifying changes

There is no test runner; verification is done by driving the real thing.

- **Against the live API** — set `SIGNAL_API_URL` and exercise the REST endpoints
  with curl. Be careful: sends and remote deletes reach real people. Use
  Note-to-Self, or a message you created yourself, for destructive tests.
- **Against a mock** — for anything involving other participants (group read
  receipts, membership changes), stand up a small HTTP server implementing
  `/v1/about`, `/v1/health`, `/v1/accounts`, `/v1/identities`, `/v1/contacts`,
  `/v1/groups`, `/v1/receive`, `/v2/send`, `/v1/receipts`, point `SIGNAL_API_URL`
  at it, and assert on what it was asked to send. This is how group receipts and
  the membership-diff messages were checked without messaging anyone.
- **UI** — `puppeteer-core` against the installed Chrome
  (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`), asserting on
  DOM state and collecting `pageerror`/`console.error`/4xx responses. Install
  puppeteer-core in a scratch directory, not in this project.

## Importing other agent configs

A `~/.codex/config.toml` exists on this machine. If you want its user-level
items (MCP servers, prompts, instructions) available in Claude Code, reply
`/import` to see what is importable, then `/import --yes=<digest>` to apply it.
