import { api, connectStream, fileToDataUri } from './api.js';
import {
  colorFor,
  initials,
  formatTime,
  formatDay,
  formatListTime,
  formatBytes,
  renderBody,
  linkify,
} from './format.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const REACTION_SET = ['👍', '👎', '❤️', '😂', '😮', '😢'];

/**
 * crypto.randomUUID is gated behind a secure context, so it does not exist when
 * this is served over plain HTTP to a LAN address — which is the normal way to
 * reach it from a phone. Fall back to a good-enough unique id.
 */
function newId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const state = {
  me: null,
  conversations: new Map(),
  activeId: null,
  messages: [],
  nodes: new Map(),      // message id -> DOM row
  hasMore: false,
  stickToBottom: true,
  missedWhileScrolled: 0,
  reply: null,
  pendingFiles: [],
  typingPeers: new Map(),  // conversationId -> timeout handle
  typingSentAt: 0,
  searchQuery: '',
  sheetTarget: null,
  stream: null,
  loading: false,           // a thread fetch is in flight
  arrivedWhileLoading: [],  // messages to replay once it lands
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  const session = await api.getSession().catch(() => ({ authRequired: true, authenticated: false }));

  if (session.authRequired && !session.authenticated) {
    showLogin();
    return;
  }
  await startApp();
}

function showLogin() {
  $('login').hidden = false;
  $('app').hidden = true;
  $('login-password').focus();

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.textContent = '';
    try {
      await api.login($('login-password').value);
      $('login').hidden = true;
      await startApp();
    } catch (ex) {
      err.textContent = ex.message;
      $('login-password').select();
    }
  });
}

async function startApp() {
  $('app').hidden = false;
  $('login').hidden = true;

  state.me = await api.me();
  applyMe(state.me);
  // The session cookie is HttpOnly, so ask the server whether a login exists
  // to sign out of rather than sniffing document.cookie (which never sees it).
  const session = await api.getSession().catch(() => null);
  $('btn-logout').hidden = !session?.authRequired;

  applyStatus(state.me.status);

  const { conversations } = await api.conversations();
  replaceConversations(conversations);

  wireUi();

  state.stream = connectStream({
    onEvent: handleEvent,
    onOpen: () => {
      setDot('up');
      // A reconnect may have missed events; resync the list and open thread.
      refreshAll();
    },
    onClose: () => setDot('down'),
  });

  registerServiceWorker();
  restoreLastConversation();
}

async function refreshAll() {
  try {
    const { conversations } = await api.conversations();
    replaceConversations(conversations);
    if (state.activeId) await openConversation(state.activeId, { keepScroll: true });
  } catch {
    /* the stream will retry */
  }
}

// ---------------------------------------------------------------------------
// Server events
// ---------------------------------------------------------------------------

function handleEvent(ev) {
  switch (ev.type) {
    case 'hello':
      if (ev.conversations) replaceConversations(ev.conversations);
      if (ev.me?.number) applyMe(ev.me);
      applyStatus(ev.status);
      break;

    // The Signal link came up after this page loaded.
    case 'me':
      applyMe(ev.me);
      break;

    case 'status':
      applyStatus(ev);
      break;

    case 'conversations':
      replaceConversations(ev.conversations);
      break;

    case 'conversation':
      upsertConversation(ev.conversation);
      break;

    case 'message':
      if (ev.conversation) upsertConversation(ev.conversation);
      onIncomingMessage(ev.message);
      break;

    case 'message_update':
      if (ev.conversation) upsertConversation(ev.conversation);
      onMessageUpdate(ev.message);
      break;

    case 'message_removed':
      removeMessageNode(ev.id);
      break;

    case 'conversation_removed':
      onConversationRemoved(ev.conversationId);
      break;

    case 'typing':
      onTyping(ev);
      break;
  }
}

function applyMe(me) {
  if (!me) return;
  state.me = { ...(state.me || {}), ...me };
  $('account-label').textContent = me.number || 'Not linked';
}

function applyStatus(status) {
  if (!status) return;
  setDot(status.connected ? 'up' : 'down');
  const dot = $('status-dot');
  dot.title = status.connected
    ? `Connected (${status.transport})`
    : `Disconnected${status.lastError ? `: ${status.lastError}` : ''}`;
}

function setDot(s) {
  $('status-dot').dataset.state = s;
}

function onIncomingMessage(msg) {
  if (!msg) return;

  if (msg.conversationId !== state.activeId) {
    maybeNotify(msg);
    return;
  }

  // A message that lands while the thread is still fetching would be appended
  // to a list that renderMessages() is about to replace — and the in-flight
  // fetch predates it, so it would silently vanish until the next reload.
  if (state.loading) {
    state.arrivedWhileLoading.push(msg);
    if (msg.direction === 'in') maybeNotify(msg);
    return;
  }

  // Replace an existing node (a resend of the same message) or append.
  if (state.nodes.has(msg.id)) {
    onMessageUpdate(msg);
    return;
  }

  const prev = state.messages[state.messages.length - 1] || null;
  state.messages.push(msg);
  const node = renderRow(msg, prev);
  $('message-list').appendChild(node);
  clearTypingFor(msg.conversationId, msg.authorId);

  // Your own message always pulls the view down — you just wrote it, so being
  // left staring at older messages is never what you wanted.
  if (msg.direction === 'out') state.stickToBottom = true;

  if (state.stickToBottom) {
    scrollToBottom();
    if (msg.direction === 'in') markReadSoon(msg.conversationId);
  } else if (msg.direction === 'in') {
    state.missedWhileScrolled++;
    updateScrollBadge();
  }

  if (msg.direction === 'in') maybeNotify(msg);
}

function onMessageUpdate(msg) {
  if (!msg || msg.conversationId !== state.activeId) return;

  const idx = state.messages.findIndex((m) => m.id === msg.id);
  if (idx === -1) {
    // An update for something we never drew (e.g. loaded before our window).
    return;
  }

  state.messages[idx] = msg;
  const old = state.nodes.get(msg.id);
  if (!old) return;

  const wasAtBottom = state.stickToBottom;
  // The day separator is already in the DOM as a sibling — re-emitting it here
  // would duplicate it on every status tick.
  const fresh = renderRow(msg, state.messages[idx - 1] || null, { includeDay: false });
  old.replaceWith(fresh);
  if (wasAtBottom) scrollToBottom();
}

function removeMessageNode(id) {
  const node = state.nodes.get(id);
  if (node) {
    // A row may be introduced by a day separator that nothing else owns; drop
    // it too, or an empty "Today" pill is left behind.
    const prev = node.previousElementSibling;
    if (prev?.classList.contains('day-sep') && !node.nextElementSibling) prev.remove();
    node.remove();
  }
  state.nodes.delete(id);
  state.messages = state.messages.filter((m) => m.id !== id);
}

function onTyping({ conversationId, authorId, started }) {
  if (conversationId !== state.activeId) return;

  const key = `${conversationId}:${authorId}`;
  clearTimeout(state.typingPeers.get(key));

  if (!started) {
    state.typingPeers.delete(key);
    renderTyping();
    return;
  }

  // Signal only sends STARTED; assume it lapses after 12s of silence.
  state.typingPeers.set(
    key,
    setTimeout(() => {
      state.typingPeers.delete(key);
      renderTyping();
    }, 12000)
  );
  renderTyping();
}

function clearTypingFor(conversationId, authorId) {
  const key = `${conversationId}:${authorId}`;
  if (state.typingPeers.has(key)) {
    clearTimeout(state.typingPeers.get(key));
    state.typingPeers.delete(key);
    renderTyping();
  }
}

function renderTyping() {
  const any = [...state.typingPeers.keys()].some((k) => k.startsWith(`${state.activeId}:`));
  $('typing-row').hidden = !any;
  if (any && state.stickToBottom) scrollToBottom();
}

// ---------------------------------------------------------------------------
// Conversation list
// ---------------------------------------------------------------------------

function replaceConversations(list) {
  state.conversations = new Map((list || []).map((c) => [c.id, c]));
  renderConversationList();
  // A wholesale refresh can change the open thread's title or member count
  // (someone left the group), so redraw its header too.
  const active = state.activeId && state.conversations.get(state.activeId);
  if (active) renderThreadHeader(active);
}

function upsertConversation(conv) {
  if (!conv) return;
  state.conversations.set(conv.id, conv);
  renderConversationList();
  if (conv.id === state.activeId) renderThreadHeader(conv);
}

function sortedConversations() {
  return [...state.conversations.values()].sort(
    (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0)
  );
}

function renderConversationList() {
  const root = $('conv-list');
  // This rebuilds the list on every incoming event; without restoring the
  // offset the list snaps to the top each time a message arrives.
  const keepScroll = root.scrollTop;
  const q = state.searchQuery.toLowerCase();

  let items = sortedConversations();
  if (q) {
    items = items.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.preview?.text || '').toLowerCase().includes(q)
    );
  }

  root.textContent = '';

  if (!items.length) {
    root.appendChild(
      el(
        'p',
        'empty-note',
        q ? 'No conversations match that search.' : 'No conversations yet. Start one with the ✎ button.'
      )
    );
    return;
  }

  for (const conv of items) {
    const btn = el('button', 'conv');
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.setAttribute('aria-selected', String(conv.id === state.activeId));
    if (conv.unread > 0) btn.classList.add('conv--unread');

    btn.appendChild(avatarFor(conv));

    const body = el('div', 'conv__body');
    const top = el('div', 'conv__top');
    top.appendChild(el('span', 'conv__name', conv.name));
    top.appendChild(el('span', 'conv__time', formatListTime(conv.lastActivity)));
    body.appendChild(top);

    const bottom = el('div', 'conv__bottom');
    bottom.appendChild(el('span', 'conv__preview', previewLine(conv)));
    if (conv.unread > 0) bottom.appendChild(el('span', 'conv__badge', String(conv.unread)));
    body.appendChild(bottom);

    btn.appendChild(body);
    btn.addEventListener('click', () => openConversation(conv.id));
    root.appendChild(btn);
  }

  root.scrollTop = keepScroll;
}

function previewLine(conv) {
  const p = conv.preview;
  if (!p) return conv.type === 'group' ? 'No messages yet' : '';
  const who =
    conv.type === 'group' && p.direction === 'in' && p.authorName
      ? `${p.authorName.split(' ')[0]}: `
      : p.direction === 'out'
        ? 'You: '
        : '';
  return `${who}${p.text || ''}`;
}

function avatarFor(conv, small) {
  const av = el('div', small ? 'avatar avatar--sm' : 'avatar');
  av.style.background = colorFor(conv.id || conv.name || '');
  av.textContent = conv.type === 'self' ? '★' : initials(conv.name);

  if (conv.hasAvatar) {
    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.src = `/api/avatars/${encodeURIComponent(conv.id)}`;
    img.onload = () => {
      av.textContent = '';
      av.appendChild(img);
    };
    // A 404 just means no avatar; the initials already cover it.
  }
  return av;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

async function openConversation(id, { keepScroll = false } = {}) {
  const conv = state.conversations.get(id);
  if (!conv) return;

  const switching = state.activeId !== id;
  state.activeId = id;
  localStorage.setItem('swc:last', id);

  document.body.dataset.pane = 'thread';
  $('thread-empty').hidden = true;
  $('thread-inner').hidden = false;

  renderThreadHeader(conv);
  renderConversationList();

  if (switching) {
    state.reply = null;
    renderReplyBar();
    clearPendingFiles();
    $('input').value = conv.draft || '';
    autogrow($('input'));
    updateSendEnabled();
    state.typingPeers.clear();
    renderTyping();
  }

  const prevTop = $('messages').scrollTop;

  let payload;
  state.loading = true;
  state.arrivedWhileLoading = [];
  try {
    payload = await api.messages(id, { limit: 50 });
  } catch (err) {
    toast(`Could not load messages: ${err.message}`);
    return;
  } finally {
    state.loading = false;
  }

  // The user may have moved on while this was in flight; rendering now would
  // put one conversation's messages under another's header.
  if (state.activeId !== id) return;

  state.messages = payload.messages;
  state.hasMore = payload.hasMore;
  renderMessages();

  // Replay anything that arrived mid-fetch, skipping what the response already
  // contained.
  const buffered = state.arrivedWhileLoading;
  state.arrivedWhileLoading = [];
  for (const m of buffered) {
    if (m.conversationId === id && !state.nodes.has(m.id)) onIncomingMessage(m);
  }

  if (keepScroll && !switching) {
    // This path replaces the same window of messages, appending anything new
    // below — so simply holding the previous offset is correct.
    $('messages').scrollTop = prevTop;
  } else {
    state.stickToBottom = true;
    state.missedWhileScrolled = 0;
    updateScrollBadge();
    scrollToBottom('auto');
  }

  if (conv.unread > 0) markReadSoon(id);
}

function renderThreadHeader(conv) {
  $('thread-name').textContent = conv.name;

  const avatarSlot = $('thread-avatar');
  // Rebuilding this on every delivery tick restarts the avatar image load and
  // flashes the initials, so only redraw when the subject actually changes.
  const key = `${conv.id}|${conv.name}|${conv.hasAvatar ? 1 : 0}`;
  if (avatarSlot.dataset.key !== key) {
    const fresh = avatarFor(conv);
    fresh.id = 'thread-avatar';
    fresh.dataset.key = key;
    avatarSlot.replaceWith(fresh);
  }

  let sub = '';
  if (conv.type === 'group') {
    const n = conv.members?.length;
    sub = n ? `${n} member${n === 1 ? '' : 's'}` : 'Group';
  } else if (conv.type === 'self') {
    sub = 'Only visible to you';
  } else {
    const c = conv.contactId || '';
    sub = /^\+/.test(c) ? c : '';
  }
  $('thread-sub').textContent = sub;
}

function renderMessages() {
  const list = $('message-list');
  list.textContent = '';
  state.nodes.clear();

  $('load-more').hidden = !state.hasMore;

  let prev = null;
  for (const msg of state.messages) {
    list.appendChild(renderRow(msg, prev));
    prev = msg;
  }
}

/** Build one message row, including any day separator it needs to introduce. */
function renderRow(msg, prev, { includeDay = true } = {}) {
  const frag = document.createDocumentFragment();

  const needsDay = !prev || formatDay(prev.ts) !== formatDay(msg.ts);
  if (needsDay && includeDay) frag.appendChild(el('div', 'day-sep', formatDay(msg.ts)));

  if (msg.kind === 'event') {
    const row = el('div', 'event-row', msg.body);
    row.dataset.mid = msg.id;
    state.nodes.set(msg.id, row);
    frag.appendChild(row);
    return frag;
  }

  const conv = state.conversations.get(msg.conversationId);
  const isGroup = conv?.type === 'group';
  const out = msg.direction === 'out';
  const startsGroup =
    needsDay || !prev || prev.authorId !== msg.authorId || msg.ts - prev.ts > 5 * 60 * 1000;

  const row = el('div', `row ${out ? 'row--out' : 'row--in'}`);
  if (startsGroup) row.classList.add('row--group-start');
  row.dataset.mid = msg.id;
  if (msg.status === 'pending') row.classList.add('sending');
  if (msg.status === 'failed') row.classList.add('failed');

  // Group chats show who spoke; 1:1 chats don't need the avatar column.
  if (isGroup && !out) {
    if (startsGroup) {
      row.appendChild(
        avatarFor({ id: msg.authorId, name: msg.authorName, type: 'dm' }, true)
      );
    } else {
      row.appendChild(el('div', 'row__spacer'));
    }
  }

  const wrap = el('div', 'bubble-wrap');
  if (isGroup && !out && startsGroup) {
    wrap.appendChild(el('div', 'sender-name', msg.authorName || 'Unknown'));
  }

  wrap.appendChild(buildBubble(msg, out, startsGroup));

  if (msg.reactions?.length) wrap.appendChild(buildReactions(msg));
  if (msg.status === 'failed') {
    wrap.appendChild(el('div', 'failed-note', msg.error ? `Not delivered — ${msg.error}` : 'Not delivered'));
  }

  row.appendChild(wrap);
  state.nodes.set(msg.id, row);
  frag.appendChild(row);
  return frag;
}

function buildBubble(msg, out, startsGroup) {
  const bubble = el('div', `bubble ${out ? 'bubble--out' : 'bubble--in'}`);
  if (startsGroup) bubble.classList.add(out ? 'bubble--tail-out' : 'bubble--tail-in');

  if (msg.deleted) {
    bubble.classList.add('bubble--deleted');
    bubble.appendChild(document.createTextNode('This message was deleted'));
    bubble.appendChild(buildMeta(msg, out));
    return bubble;
  }

  if (msg.quote) bubble.appendChild(buildQuote(msg.quote));

  const media = (msg.attachments || []).filter((a) =>
    /^(image|video)\//.test(a.contentType || '')
  );
  const audio = (msg.attachments || []).filter((a) => /^audio\//.test(a.contentType || ''));
  const files = (msg.attachments || []).filter(
    (a) => !/^(image|video|audio)\//.test(a.contentType || '')
  );

  if (media.length) {
    bubble.classList.add('bubble--media');
    if (msg.body) bubble.classList.add('bubble--text-too');
    bubble.appendChild(buildMedia(media));
  }

  for (const a of audio) {
    const player = document.createElement('audio');
    player.controls = true;
    player.preload = 'none';
    player.src = `/api/attachments/${encodeURIComponent(a.id)}`;
    bubble.appendChild(player);
  }

  for (const a of files) bubble.appendChild(buildFileChip(a));

  if (msg.sticker && !msg.body) {
    bubble.appendChild(el('div', 'sticker', '🏷️ Sticker'));
  }

  if (msg.body) {
    const text = el('span', 'bubble__text');
    text.appendChild(linkify(renderBody(msg.body, msg.mentions, msg.textStyles)));
    bubble.appendChild(text);
  }

  bubble.appendChild(buildMeta(msg, out));
  attachMessageActions(bubble, msg);
  return bubble;
}

function buildMeta(msg, out) {
  const meta = el('div', 'bubble__meta');
  if (msg.editedAt) meta.appendChild(el('span', 'edited', 'edited'));
  meta.appendChild(el('span', 'time', formatTime(msg.ts)));
  if (out) meta.appendChild(buildTick(msg.status));
  return meta;
}

function buildTick(status) {
  const wrap = el('span', 'tick');
  if (status === 'read') wrap.classList.add('tick--read');

  const svg = (d) =>
    `<svg viewBox="0 0 20 16" width="16" height="12" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;

  if (status === 'pending') {
    wrap.innerHTML = svg('M10 2a6 6 0 1 0 0 12A6 6 0 0 0 10 2Zm0 1.5A4.5 4.5 0 1 1 10 12.5 4.5 4.5 0 0 1 10 3.5Zm-.6 1.4v3.4l2.6 1.6.6-1-2-1.2V4.9h-1.2Z');
    wrap.title = 'Sending…';
  } else if (status === 'failed') {
    wrap.innerHTML = svg('M9.2 2h1.6v7H9.2V2Zm0 9h1.6v1.8H9.2V11Z');
    wrap.title = 'Failed to send';
  } else if (status === 'delivered' || status === 'read') {
    wrap.innerHTML = svg('M6.6 12.4 2.2 8l1.1-1.1 3.3 3.3 7-7L14.7 4.3l-8.1 8.1Zm5 0L7.2 8l1.1-1.1 3.3 3.3 7-7 1.1 1.1-8.1 8.1Z');
    wrap.title = status === 'read' ? 'Read' : 'Delivered';
  } else {
    wrap.innerHTML = svg('M6.6 12.4 2.2 8l1.1-1.1 3.3 3.3 7-7L14.7 4.3l-8.1 8.1Z');
    wrap.title = 'Sent';
  }
  return wrap;
}

function buildQuote(quote) {
  const box = el('div', 'quote-box');
  box.appendChild(el('div', 'quote-box__bar'));
  const body = el('div');
  body.appendChild(el('div', 'quote-box__who', quote.authorName || 'Unknown'));
  body.appendChild(
    el('div', 'quote-box__text', quote.text || (quote.attachments?.length ? 'Attachment' : ''))
  );
  box.appendChild(body);
  return box;
}

function buildMedia(items) {
  const grid = el('div', `media${items.length > 1 ? ' media--multi' : ''}`);

  for (const a of items) {
    const url = `/api/attachments/${encodeURIComponent(a.id)}`;
    if (/^video\//.test(a.contentType)) {
      const v = document.createElement('video');
      v.src = url;
      v.controls = true;
      v.preload = 'metadata';
      v.playsInline = true;
      grid.appendChild(v);
    } else {
      const img = new Image();
      img.src = url;
      img.alt = a.filename || 'Photo';
      img.loading = 'lazy';
      if (a.width && a.height && items.length === 1) {
        img.style.aspectRatio = `${a.width} / ${a.height}`;
      }
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(a, url);
      });
      // A photo that finishes decoding after insertion grows the thread; keep
      // the newest message in view rather than drifting above it.
      img.addEventListener('load', () => {
        if (state.stickToBottom) scrollToBottom();
      });
      grid.appendChild(img);
    }
  }
  return grid;
}

function buildFileChip(a) {
  const chip = el('a', 'file-chip');
  chip.href = `/api/attachments/${encodeURIComponent(a.id)}?download=1`;
  chip.download = a.filename || 'file';

  const icon = el('span', 'file-chip__icon');
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 2 4 4h-4V4Z"/></svg>';
  chip.appendChild(icon);

  const meta = el('div');
  meta.appendChild(el('div', 'file-chip__name', a.filename || 'Attachment'));
  if (a.size) meta.appendChild(el('div', 'file-chip__size', formatBytes(a.size)));
  chip.appendChild(meta);
  return chip;
}

function buildReactions(msg) {
  const wrap = el('div', 'reactions');
  const byEmoji = new Map();
  for (const r of msg.reactions) {
    const entry = byEmoji.get(r.emoji) || { count: 0, mine: false, names: [] };
    entry.count++;
    entry.mine = entry.mine || r.mine;
    entry.names.push(r.authorName || 'Someone');
    byEmoji.set(r.emoji, entry);
  }

  for (const [emoji, info] of byEmoji) {
    const pill = el('button', `reaction${info.mine ? ' reaction--mine' : ''}`);
    pill.type = 'button';
    pill.title = info.names.join(', ');
    pill.appendChild(document.createTextNode(emoji));
    if (info.count > 1) pill.appendChild(el('span', 'reaction__count', String(info.count)));
    pill.addEventListener('click', () => toggleReaction(msg, emoji, info.mine));
    wrap.appendChild(pill);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Message actions (reply / react / copy / hide)
// ---------------------------------------------------------------------------

function attachMessageActions(bubble, msg) {
  let timer = null;

  const open = (e) => {
    e.preventDefault();
    openSheet(msg);
  };

  bubble.addEventListener('contextmenu', open);

  // Long-press on touch, without swallowing normal taps or text selection.
  bubble.addEventListener(
    'touchstart',
    () => {
      timer = setTimeout(() => {
        navigator.vibrate?.(12);
        openSheet(msg);
      }, 480);
    },
    { passive: true }
  );
  const cancel = () => clearTimeout(timer);
  bubble.addEventListener('touchend', cancel);
  bubble.addEventListener('touchmove', cancel, { passive: true });
  bubble.addEventListener('touchcancel', cancel);

  bubble.addEventListener('dblclick', () => toggleReaction(msg, '👍', hasMyReaction(msg, '👍')));
}

const hasMyReaction = (msg, emoji) =>
  (msg.reactions || []).some((r) => r.mine && r.emoji === emoji);

function openSheet(msg) {
  state.sheetTarget = msg;
  const sheet = $('sheet');
  const rack = $('sheet-reactions');
  rack.textContent = '';

  for (const emoji of REACTION_SET) {
    const b = el('button', null, emoji);
    b.type = 'button';
    const mine = hasMyReaction(msg, emoji);
    b.setAttribute('aria-pressed', String(mine));
    b.addEventListener('click', () => {
      closeSheet();
      toggleReaction(msg, emoji, mine);
    });
    rack.appendChild(b);
  }

  sheet.querySelector('[data-act="copy"]').hidden = !msg.body;

  // Signal only lets you retract your own messages, and there's nothing left to
  // retract once it's already been deleted.
  const canUnsend = msg.direction === 'out' && !msg.deleted && msg.status !== 'pending';
  sheet.querySelector('[data-act="delete-everyone"]').hidden = !canUnsend;

  sheet.hidden = false;
}

function closeSheet() {
  $('sheet').hidden = true;
  state.sheetTarget = null;
}

async function toggleReaction(msg, emoji, remove) {
  try {
    await api.react(msg.conversationId, {
      targetTs: msg.ts,
      targetAuthorId: msg.authorId,
      emoji,
      remove: !!remove,
    });
  } catch (e) {
    toast(e.message);
  }
}

// ---------------------------------------------------------------------------
// Signed-in devices
// ---------------------------------------------------------------------------

async function openSessions() {
  const dialog = $('sessions-dialog');
  const list = $('sessions-list');
  list.textContent = '';
  list.appendChild(el('p', 'muted', 'Loading…'));
  if (!dialog.open) dialog.showModal();

  let data;
  try {
    data = await api.sessions();
  } catch (err) {
    list.textContent = '';
    list.appendChild(el('p', 'muted', `Could not load devices: ${err.message}`));
    return;
  }

  $('sessions-hint').textContent = data.authRequired
    ? 'Devices that have signed in with your password. Sign out any you don’t recognise.'
    : 'No password is set, so there are no saved logins — this shows browsers connected right now.';

  const others = data.sessions.filter((s) => s.revocable && !s.current);
  $('sessions-revoke-others').hidden = others.length === 0;

  list.textContent = '';
  if (!data.sessions.length) {
    list.appendChild(el('p', 'muted', 'No devices connected.'));
    return;
  }

  for (const s of data.sessions) list.appendChild(renderSession(s));
}

function renderSession(s) {
  const row = el('div', `session${s.current ? ' session--current' : ''}`);

  const dot = el('span', `session__dot${s.connected ? ' session__dot--live' : ''}`);
  dot.title = s.connected ? 'Connected now' : 'Not connected';
  row.appendChild(dot);

  const body = el('div', 'session__body');
  const name = el('div', 'session__name');
  name.appendChild(document.createTextNode(s.label));
  if (s.current) name.appendChild(el('span', 'session__tag', 'This device'));
  body.appendChild(name);

  const bits = [];
  if (s.connected) bits.push(s.connections > 1 ? `${s.connections} tabs open` : 'Connected now');
  else bits.push(`Last active ${relativeTime(s.lastSeenAt)}`);
  if (s.ip) bits.push(s.ip);
  if (s.expiresAt) bits.push(`expires ${relativeTime(s.expiresAt)}`);
  body.appendChild(el('div', 'session__meta', bits.join(' · ')));
  row.appendChild(body);

  if (s.revocable) {
    const btn = el('button', 'session__revoke', s.current ? 'Sign out' : 'Revoke');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      const warning = s.current
        ? 'Sign out this device?'
        : `Sign out “${s.label}”? It will need the password again.`;
      if (!confirm(warning)) return;
      btn.disabled = true;
      try {
        await api.revokeSession(s.id);
        if (s.current) return location.reload();
        toast('Device signed out');
        openSessions();
      } catch (err) {
        btn.disabled = false;
        toast(err.message);
      }
    });
    row.appendChild(btn);
  }

  return row;
}

/** "3 minutes ago" / "in 29 days" — good enough without a date library. */
function relativeTime(ts) {
  if (!ts) return 'unknown';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const units = [
    [60_000, 'minute', 1000],
    [3_600_000, 'hour', 60_000],
    [86_400_000, 'day', 3_600_000],
    [Infinity, 'day', 86_400_000],
  ];
  if (abs < 60_000) return diff < 0 ? 'just now' : 'shortly';
  const [, unit, divisor] = units.find(([limit]) => abs < limit) || units[units.length - 1];
  const n = Math.round(abs / divisor);
  const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return diff < 0 ? `${label} ago` : `in ${label}`;
}

// ---------------------------------------------------------------------------
// Conversation menu
// ---------------------------------------------------------------------------

function openThreadMenu() {
  const conv = state.conversations.get(state.activeId);
  if (!conv) return;
  const menu = $('thread-menu');

  menu.querySelector('[data-act="mute"]').textContent = conv.muted
    ? 'Unmute notifications'
    : 'Mute notifications';

  // You can only leave a group you're still in; Note to Self can't be left or
  // meaningfully deleted upstream.
  const stillMember = conv.type === 'group' && isMember(conv);
  menu.querySelector('[data-act="leave"]').hidden = !stillMember;
  menu.querySelector('[data-act="delete-conversation"]').hidden = conv.type === 'self';
  menu.querySelector('[data-act="delete-conversation"]').textContent =
    conv.type === 'group' ? 'Delete group' : 'Delete conversation';

  menu.hidden = false;
}

const closeThreadMenu = () => ($('thread-menu').hidden = true);

function isMember(conv) {
  const me = state.me || {};
  return (conv.members || []).some((m) => m === me.number || m === me.uuid);
}

async function runConversationAction(act, conv) {
  try {
    if (act === 'mute') {
      const { conversation } = await api.patchConversation(conv.id, { muted: !conv.muted });
      upsertConversation(conversation);
      toast(conversation.muted ? 'Muted' : 'Unmuted');
      return;
    }

    if (act === 'refresh') {
      const { conversations } = await api.conversations(true);
      replaceConversations(conversations);
      toast('Contacts and groups refreshed');
      return;
    }

    if (act === 'leave') {
      if (!confirm(`Leave “${conv.name}”? The other members will be notified.`)) return;
      await api.leaveGroup(conv.id);
      toast('You left the group');
      return;
    }

    if (act === 'delete-conversation') {
      const warning =
        conv.type === 'group'
          ? `Delete “${conv.name}”? This removes the group and its history from this client.`
          : `Delete this conversation? Its history is removed from this client only.`;
      if (!confirm(warning)) return;
      await api.deleteConversation(conv.id);
      // The server broadcasts conversation_removed, which clears the view.
    }
  } catch (err) {
    toast(err.message);
  }
}

function onConversationRemoved(conversationId) {
  state.conversations.delete(conversationId);
  if (state.activeId === conversationId) {
    state.activeId = null;
    state.messages = [];
    state.nodes.clear();
    $('message-list').textContent = '';
    $('thread-inner').hidden = true;
    $('thread-empty').hidden = false;
    document.body.dataset.pane = 'list';
    localStorage.removeItem('swc:last');
  }
  renderConversationList();
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function updateSendEnabled() {
  const hasText = $('input').value.trim().length > 0;
  $('btn-send').disabled = !hasText && state.pendingFiles.length === 0;
}

function autogrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
}

async function doSend() {
  const input = $('input');
  const body = input.value.trim();
  if (!body && !state.pendingFiles.length) return;
  if (!state.activeId) return;

  const conversationId = state.activeId;
  const attachments = state.pendingFiles.map((f) => f.dataUri);
  const quote = state.reply
    ? { ts: state.reply.ts, authorId: state.reply.authorId, text: state.reply.body || '' }
    : null;

  // Keep what we're clearing, so a failed send can hand it all back.
  const sentFiles = state.pendingFiles;
  const sentReply = state.reply;

  // Clear the composer immediately; the bubble arrives over the stream.
  input.value = '';
  autogrow(input);
  state.pendingFiles = [];
  renderPendingFiles();
  state.reply = null;
  renderReplyBar();
  updateSendEnabled();
  api.patchConversation(conversationId, { draft: '' }).catch(() => {});

  // Follow your own message down even if you were reading further up.
  state.stickToBottom = true;
  scrollToBottom();

  $('btn-send').disabled = true;
  try {
    await api.send(conversationId, { body, attachments, quote, clientId: newId() });
  } catch (e) {
    toast(`Could not send: ${e.message}`);
    // Restore the whole composer — losing an attached photo to a failed
    // request means re-picking it from scratch.
    if (conversationId === state.activeId) {
      if (!input.value) {
        input.value = body;
        autogrow(input);
      }
      if (sentFiles.length) {
        state.pendingFiles = sentFiles;
        renderPendingFiles();
      }
      if (sentReply) {
        state.reply = sentReply;
        renderReplyBar();
      }
    }
  } finally {
    updateSendEnabled();
  }
}

function renderReplyBar() {
  const bar = $('composer-reply');
  if (!state.reply) {
    bar.hidden = true;
    return;
  }
  $('reply-who').textContent =
    state.reply.direction === 'out' ? 'You' : state.reply.authorName || 'Unknown';
  $('reply-text').textContent =
    state.reply.body || (state.reply.attachments?.length ? 'Attachment' : '');
  bar.hidden = false;
  $('input').focus();
}

async function addFiles(fileList) {
  const max = state.me?.features?.maxUploadBytes ?? 100 * 1024 * 1024;
  for (const file of fileList) {
    if (file.size > max) {
      toast(`${file.name} is larger than ${formatBytes(max)}`);
      continue;
    }
    try {
      const dataUri = await fileToDataUri(file);
      state.pendingFiles.push({ file, dataUri });
    } catch (e) {
      toast(e.message);
    }
  }
  renderPendingFiles();
  updateSendEnabled();
}

function renderPendingFiles() {
  const rack = $('composer-attachments');
  rack.textContent = '';
  rack.hidden = state.pendingFiles.length === 0;

  state.pendingFiles.forEach((entry, i) => {
    const chip = el('div', 'chip');
    if (entry.file.type.startsWith('image/')) {
      const img = new Image();
      img.src = URL.createObjectURL(entry.file);
      img.onload = () => URL.revokeObjectURL(img.src);
      chip.appendChild(img);
    }
    chip.appendChild(el('span', 'chip__name', entry.file.name || 'attachment'));

    const x = el('button', 'chip__x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', `Remove ${entry.file.name}`);
    x.addEventListener('click', () => {
      state.pendingFiles.splice(i, 1);
      renderPendingFiles();
      updateSendEnabled();
    });
    chip.appendChild(x);
    rack.appendChild(chip);
  });
}

function clearPendingFiles() {
  state.pendingFiles = [];
  renderPendingFiles();
}

function notifyTyping() {
  if (!state.activeId) return;
  const now = Date.now();
  // Signal's indicator lasts ~15s; re-arm at most every 8s.
  if (now - state.typingSentAt < 8000) return;
  state.typingSentAt = now;
  api.typing(state.activeId, true).catch(() => {});
}

// ---------------------------------------------------------------------------
// Scrolling & read state
// ---------------------------------------------------------------------------

function scrollToBottom(behavior = 'auto') {
  const box = $('messages');
  box.scrollTo({ top: box.scrollHeight, behavior });
  state.missedWhileScrolled = 0;
  updateScrollBadge();
}

function updateScrollBadge() {
  $('scroll-down').hidden = state.stickToBottom;
  const badge = $('scroll-badge');
  badge.hidden = state.missedWhileScrolled === 0;
  badge.textContent = String(state.missedWhileScrolled);
}

let readTimer = null;
function markReadSoon(conversationId = state.activeId) {
  clearTimeout(readTimer);
  // Bind the target now: switching conversations inside the debounce window
  // would otherwise mark the wrong one read.
  readTimer = setTimeout(() => {
    if (!conversationId || document.visibilityState !== 'visible') return;
    if (conversationId !== state.activeId) return;
    api.markRead(conversationId).catch(() => {});
  }, 600);
}

async function loadEarlier() {
  if (!state.messages.length) return;
  const box = $('messages');
  const conversationId = state.activeId;
  const before = state.messages[0].ts;
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;

  let payload;
  try {
    payload = await api.messages(conversationId, { before, limit: 50 });
  } catch (err) {
    toast(`Could not load earlier messages: ${err.message}`);
    return;
  }
  if (state.activeId !== conversationId) return;

  if (!payload.messages.length) {
    state.hasMore = false;
    $('load-more').hidden = true;
    return;
  }

  state.messages = [...payload.messages, ...state.messages];
  state.hasMore = payload.hasMore;
  renderMessages();
  // Content was inserted above, so shift by exactly how much the thread grew.
  box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
}

// ---------------------------------------------------------------------------
// Lightbox, toast, notifications
// ---------------------------------------------------------------------------

function openLightbox(att, url) {
  const stage = $('lightbox-stage');
  stage.textContent = '';
  const img = new Image();
  img.src = url;
  img.alt = att.filename || '';
  stage.appendChild(img);
  $('lightbox-download').href = `${url}?download=1`;
  $('lightbox-download').download = att.filename || 'photo';
  $('lightbox').hidden = false;
}

let toastTimer = null;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 4000);
}

function maybeNotify(msg) {
  if (msg.direction !== 'in') return;
  if (document.visibilityState === 'visible' && msg.conversationId === state.activeId) return;
  const conv = state.conversations.get(msg.conversationId);
  if (conv?.muted) return;
  // Optional chaining doesn't protect an undeclared global, and browsers drop
  // `Notification` entirely in insecure contexts (plain HTTP to a LAN IP).
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;

  const title = conv?.name || msg.authorName || 'Signal';
  const bodyText =
    msg.body || (msg.attachments?.length ? 'Sent an attachment' : 'New message');

  try {
    const n = new Notification(title, {
      body: bodyText,
      tag: msg.conversationId,
      icon: '/icons/icon-192.png',
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      openConversation(msg.conversationId);
      n.close();
    };
  } catch {
    /* notifications can be blocked mid-session */
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

function restoreLastConversation() {
  const last = localStorage.getItem('swc:last');
  // On phones, land on the list; on desktop, reopen where you left off.
  if (last && state.conversations.has(last) && window.innerWidth > 820) {
    openConversation(last);
  } else {
    document.body.dataset.pane = 'list';
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireUi() {
  const input = $('input');
  const box = $('messages');

  $('btn-send').addEventListener('click', doSend);

  input.addEventListener('input', () => {
    autogrow(input);
    updateSendEnabled();
    notifyTyping();
  });

  input.addEventListener('keydown', (e) => {
    // Enter sends on a physical keyboard; on touch it inserts a newline.
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      doSend();
    }
  });

  input.addEventListener('blur', () => {
    if (state.activeId) {
      api.patchConversation(state.activeId, { draft: input.value }).catch(() => {});
    }
  });

  // Paste an image straight into the composer.
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });

  // Drag & drop onto the thread.
  const thread = $('thread');
  thread.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  thread.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
  });

  box.addEventListener('scroll', () => {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (atBottom !== state.stickToBottom) {
      state.stickToBottom = atBottom;
      if (atBottom) {
        state.missedWhileScrolled = 0;
        markReadSoon();
      }
      updateScrollBadge();
    }
  });

  $('scroll-down').addEventListener('click', () => scrollToBottom('smooth'));
  $('load-more').addEventListener('click', loadEarlier);

  $('btn-back').addEventListener('click', () => {
    document.body.dataset.pane = 'list';
    state.activeId = null;
    renderConversationList();
  });

  $('reply-cancel').addEventListener('click', () => {
    state.reply = null;
    renderReplyBar();
  });

  // Search
  const search = $('search-input');
  search.addEventListener('input', () => {
    state.searchQuery = search.value.trim();
    $('search-clear').hidden = !state.searchQuery;
    renderConversationList();
  });
  $('search-clear').addEventListener('click', () => {
    search.value = '';
    state.searchQuery = '';
    $('search-clear').hidden = true;
    renderConversationList();
    search.focus();
  });

  // New conversation
  const dialog = $('new-chat-dialog');
  $('btn-new-chat').addEventListener('click', () => {
    $('new-chat-error').textContent = '';
    $('new-chat-recipient').value = '';
    dialog.showModal();
    requestNotificationPermission();
  });

  $('new-chat-cancel').addEventListener('click', () => dialog.close());

  $('new-chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const recipient = $('new-chat-recipient').value.trim();
    if (!recipient) return;
    try {
      const { conversation } = await api.startConversation(recipient);
      upsertConversation(conversation);
      dialog.close();
      openConversation(conversation.id);
    } catch (ex) {
      $('new-chat-error').textContent = ex.message;
    }
  });

  // Conversation menu
  $('btn-thread-menu').addEventListener('click', openThreadMenu);
  $('thread-menu').addEventListener('click', (e) => {
    if (e.target === $('thread-menu')) return closeThreadMenu();
    const act = e.target.dataset?.act;
    if (!act) return;
    const conv = state.conversations.get(state.activeId);
    closeThreadMenu();
    if (!conv || act === 'cancel') return;
    runConversationAction(act, conv);
  });

  // Action sheet
  $('sheet').addEventListener('click', (e) => {
    if (e.target === $('sheet')) return closeSheet();
    const act = e.target.dataset?.act;
    if (!act) return;
    const msg = state.sheetTarget;
    closeSheet();
    if (!msg) return;

    if (act === 'reply') {
      state.reply = msg;
      renderReplyBar();
    } else if (act === 'copy') {
      navigator.clipboard?.writeText(msg.body || '').then(
        () => toast('Copied'),
        () => toast('Could not copy')
      );
    } else if (act === 'delete') {
      api
        .hideMessage(msg.conversationId, msg.ts, msg.authorId)
        .catch((ex) => toast(ex.message));
    } else if (act === 'delete-everyone') {
      if (!confirm('Delete this message for everyone? This cannot be undone.')) return;
      api
        .deleteForEveryone(msg.conversationId, msg.ts)
        .then(() => toast('Deleted for everyone'))
        .catch((ex) => toast(`Could not delete: ${ex.message}`));
    }
  });

  // Lightbox
  $('lightbox-close').addEventListener('click', () => ($('lightbox').hidden = true));
  $('lightbox').addEventListener('click', (e) => {
    if (e.target === $('lightbox') || e.target.id === 'lightbox-stage') {
      $('lightbox').hidden = true;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').hidden) $('lightbox').hidden = true;
    else if (!$('sheet').hidden) closeSheet();
    else if (!$('thread-menu').hidden) closeThreadMenu();
  });

  $('btn-sessions').addEventListener('click', openSessions);
  $('sessions-close').addEventListener('click', () => $('sessions-dialog').close());
  $('sessions-revoke-others').addEventListener('click', async () => {
    if (!confirm('Sign out every other device?')) return;
    try {
      const { revoked } = await api.revokeOtherSessions();
      toast(revoked ? `Signed out ${revoked} device${revoked === 1 ? '' : 's'}` : 'No other devices');
      openSessions();
    } catch (err) {
      toast(err.message);
    }
  });

  $('btn-logout').addEventListener('click', async () => {
    await api.logout().catch(() => {});
    location.reload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.activeId) markReadSoon();
  });

  document.addEventListener('click', requestNotificationPermission, { once: true });
}

function requestNotificationPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

boot().catch((err) => {
  // Built rather than interpolated into innerHTML: err.message can carry text
  // that started life on the server (an API error body is passed through
  // verbatim), and the boot failure screen is the one place that would render
  // it as markup. Nothing else in this app parses HTML it did not author.
  const pre = el('pre', null, `Failed to start: ${err.message}`);
  pre.style.cssText = 'padding:24px;color:#c00';
  document.body.replaceChildren(pre);
});
