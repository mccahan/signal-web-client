# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # run the server (http://localhost:8080)
npm run dev        # same, with --watch
npm run icons      # regenerate public/icons/* (rarely needed; PNGs are committed)

docker compose up -d --build
docker build -t signal-web-client . && docker run -p 8080:8080 \
  -e SIGNAL_API_URL=http://<host>:8095 -v signal-web-data:/data signal-web-client
```

Node 22.5+ is required — storage uses the built-in `node:sqlite`, so there are no
native modules. `--no-warnings=ExperimentalWarning` in the npm scripts only
silences the `node:sqlite` experimental notice.

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
