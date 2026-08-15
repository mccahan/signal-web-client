/**
 * Generates the PWA PNG icons with no image dependencies: rasterise a rounded
 * square plus a chat bubble into RGBA, then deflate it into a valid PNG.
 *
 * Run with `npm run icons`. The committed PNGs mean this normally never needs
 * to run again.
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const ACCENT = [0x3a, 0x76, 0xf0];
const WHITE = [0xff, 0xff, 0xff];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle, for cheap antialiasing. */
function roundedRectSdf(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Smooth union, so the tail melts into the disc instead of notching it. */
function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/**
 * Signal's mark is a speech bubble: a disc with a tail at the lower left.
 *
 * The tail is kept smaller than the ring's stroke width, so hollowing the
 * union carves a hole out of the disc only and leaves the tail solid.
 */
function bubbleSdf(px, py, cx, cy, r) {
  const disc = Math.hypot(px - cx, py - cy) - r;
  const tx = cx - r * 0.66;
  const ty = cy + r * 0.66;
  const tail = roundedRectSdf(px, py, tx, ty, r * 0.12, r * 0.12, r * 0.04);
  return smoothMin(disc, tail, r * 0.18);
}

function render(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  // Maskable icons must survive a circular crop, so the art shrinks inside it.
  const pad = maskable ? size * 0.18 : 0;
  const radius = maskable ? size / 2 : size * 0.22;
  const bubbleR = (size - pad * 2) * 0.29;
  const cx = size / 2;
  const cy = size / 2;
  const aa = size / 220;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * size + x) * 4;

      const bg = roundedRectSdf(px, py, cx, cy, size / 2, size / 2, radius);
      const bgA = clamp01(0.5 - bg / aa);
      if (bgA <= 0) continue;

      const bub = bubbleSdf(px, py, cx, cy - size * 0.012, bubbleR);
      const ringInner = bub + bubbleR * 0.26;
      // Hollow bubble: fill between the outline and the inner edge.
      const strokeA = clamp01(0.5 - bub / aa) * (1 - clamp01(0.5 - ringInner / aa));

      const color = mix(ACCENT, WHITE, strokeA);
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = Math.round(bgA * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(outDir, name), render(size, opts));
  console.log(`wrote ${name} (${size}x${size})`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="113" fill="#3a76f0"/>
  <path fill="#fff" d="M256 106c-82.8 0-150 62.4-150 139.4 0 44.2 22.1 83.6 56.6 109.2-2.6 22.9-13.8 43.6-31.6 58.9-3.3 2.9-1.4 8.4 3 8.3 33.9-.9 65.3-12.2 90.6-30.6 10.2 1.9 20.7 2.9 31.4 2.9 82.8 0 150-62.4 150-139.4S338.8 106 256 106zm0 40c61.5 0 110 45.3 110 99.4s-48.5 99.4-110 99.4c-10.2 0-20.1-1.2-29.5-3.6l-12.2-3.1-10.4 7.6c-9.9 7.2-20.7 13.1-32.1 17.6 5.2-11.3 8.8-23.4 10.4-36.1l1.7-13.4-11.1-8.2c-26-19.3-40.8-47.8-40.8-76.2 0-54.1 48.5-99.4 110-99.4z"/>
</svg>`;
fs.writeFileSync(path.join(outDir, 'icon.svg'), svg);
console.log('wrote icon.svg');
