/** Presentation helpers: names, colours, times, and Signal's rich text. */

const AVATAR_COLORS = [
  '#5b6ee1', '#c0603f', '#2f9e5f', '#a45bc4', '#c9992b',
  '#3f8fa8', '#c05a86', '#6a7b8c', '#8a6bd1', '#4d8f3c',
];

export function colorFor(key = '') {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) {
    // Phone numbers make poor initials; use the last two digits instead.
    if (/^\+?\d+$/.test(parts[0])) return parts[0].slice(-2);
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(ts) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';

  const withinWeek = now - d < 6 * 864e5;
  if (withinWeek) return d.toLocaleDateString([], { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Compact stamp for the conversation list. */
export function formatListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return formatTime(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
}

export function formatBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const STYLE_TAGS = {
  BOLD: 'strong',
  ITALIC: 'em',
  STRIKETHROUGH: 's',
  MONOSPACE: 'code',
  SPOILER: 'span',
};

/**
 * Render a message body into a fragment, applying Signal's mention and
 * text-style ranges. Ranges may overlap, so the text is split at every
 * boundary and each segment wrapped in whichever styles cover it.
 *
 * Bad indices are ignored rather than throwing — a malformed range should
 * never cost the user the message.
 */
export function renderBody(body = '', mentions = [], textStyles = []) {
  const frag = document.createDocumentFragment();
  if (!body) return frag;

  const len = body.length;
  const clamp = (n) => Math.max(0, Math.min(len, n | 0));

  const ranges = [];
  for (const s of textStyles || []) {
    const start = clamp(s.start);
    const end = clamp(s.start + s.length);
    if (end > start && STYLE_TAGS[s.style]) ranges.push({ start, end, style: s.style });
  }

  const mentionRanges = (mentions || [])
    .map((m) => ({ start: clamp(m.start), end: clamp(m.start + m.length), mention: m }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => a.start - b.start);

  const boundaries = new Set([0, len]);
  for (const r of [...ranges, ...mentionRanges]) {
    boundaries.add(r.start);
    boundaries.add(r.end);
  }
  const points = [...boundaries].sort((a, b) => a - b);

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;

    // Prefer the mention that actually starts here; only fall back to an
    // enclosing one so overlapping ranges can't swallow a segment's text.
    const covering = mentionRanges.filter((m) => m.start <= from && m.end >= to);
    const mention = covering.find((m) => m.start === from) || covering[0];
    let node;

    if (mention) {
      // The chip stands in for the whole range, so emit it once and let the
      // range's remaining segments collapse into it.
      if (mention.start !== from) continue;
      node = document.createElement('span');
      node.className = 'mention';
      const m = mention.mention;
      node.textContent = `@${m.name || m.number || 'someone'}`;
    } else {
      node = document.createTextNode(body.slice(from, to));
    }

    let wrapped = node;
    for (const r of ranges) {
      if (r.start <= from && r.end >= to) {
        const el = document.createElement(STYLE_TAGS[r.style]);
        if (r.style === 'SPOILER') {
          el.className = 'spoiler';
          el.title = 'Tap to reveal';
          el.addEventListener('click', () => el.classList.toggle('spoiler--shown'));
        }
        el.appendChild(wrapped);
        wrapped = el;
      }
    }
    frag.appendChild(wrapped);
  }

  return frag;
}

/** Turn bare URLs into links, leaving all other text untouched. */
export function linkify(fragment) {
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  const re = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
  for (const node of targets) {
    const text = node.nodeValue;
    if (!re.test(text)) continue;
    re.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[0].startsWith('http') ? m[0] : `https://${m[0]}`;
      a.textContent = m[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
  return fragment;
}
