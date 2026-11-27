'use strict';

const zlib = require('zlib');
const crypto = require('crypto');

const INK = '#1d1d1b';
const cache = new Map();
const CACHE_MAX = 50;

function luminance(r, g, b) {
  const c = [r, g, b].map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function hexLuminance(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return luminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function readChunks(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const out = { idat: [] };
  let i = 8;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      out.width = data.readUInt32BE(0);
      out.height = data.readUInt32BE(4);
      out.depth = data[8];
      out.colour = data[9];
      out.interlace = data[12];
    } else if (type === 'PLTE') out.plte = data;
    else if (type === 'tRNS') out.trns = data;
    else if (type === 'IDAT') out.idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  return out.width ? out : null;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  const h = readChunks(buf);
  if (!h || h.interlace !== 0 || !CHANNELS[h.colour]) return null;
  if (h.width * h.height > 16e6) return null;
  const channels = CHANNELS[h.colour];
  const bitsPerPixel = channels * h.depth;
  const stride = Math.ceil((h.width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(h.idat)); } catch (_) { return null; }
  if (raw.length < (stride + 1) * h.height) return null;
  const rows = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0;
      const b = y > 0 ? rows[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      rows[dst + x] = v & 255;
    }
  }
  const sample = (y, x, ch) => {
    const row = y * stride;
    if (h.depth === 8) return rows[row + x * channels + ch];
    if (h.depth === 16) return rows[row + (x * channels + ch) * 2];
    const bit = (x * channels + ch) * h.depth;
    const byte = rows[row + (bit >> 3)];
    const v = (byte >> (8 - h.depth - (bit & 7))) & ((1 << h.depth) - 1);
    return h.colour === 3 ? v : Math.round((v * 255) / ((1 << h.depth) - 1));
  };
  return {
    width: h.width,
    height: h.height,
    pixel(x, y) {
      if (h.colour === 3) {
        const idx = sample(y, x, 0);
        if (!h.plte || idx * 3 + 2 >= h.plte.length) return [0, 0, 0, 255];
        const alpha = h.trns && idx < h.trns.length ? h.trns[idx] : 255;
        return [h.plte[idx * 3], h.plte[idx * 3 + 1], h.plte[idx * 3 + 2], alpha];
      }
      if (h.colour === 0) { const v = sample(y, x, 0); return [v, v, v, 255]; }
      if (h.colour === 4) { const v = sample(y, x, 0); return [v, v, v, sample(y, x, 1)]; }
      if (h.colour === 2) return [sample(y, x, 0), sample(y, x, 1), sample(y, x, 2), 255];
      return [sample(y, x, 0), sample(y, x, 1), sample(y, x, 2), sample(y, x, 3)];
    },
  };
}

function readsOnDark(buf, background = INK) {
  const img = decodePng(buf);
  if (!img) return false;
  const bg = hexLuminance(background);
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 200000)));
  let total = 0;
  let solid = 0;
  let legible = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      total += 1;
      const [r, g, b, a] = img.pixel(x, y);
      if (a < 128) continue;
      solid += 1;
      const l = luminance(r, g, b);
      const ratio = (Math.max(l, bg) + 0.05) / (Math.min(l, bg) + 0.05);
      if (ratio >= 3) legible += 1;
    }
  }
  if (!total || !solid) return false;
  if (solid / total > 0.9) return false;
  return legible / solid >= 0.7;
}

function dataUriReadsOnDark(uri) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(uri || ''));
  if (!m) return false;
  const key = crypto.createHash('sha256').update(m[1]).digest('hex');
  if (cache.has(key)) return cache.get(key);
  let ok = false;
  try { ok = readsOnDark(Buffer.from(m[1], 'base64')); } catch (_) { ok = false; }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, ok);
  return ok;
}

module.exports = { decodePng, readsOnDark, dataUriReadsOnDark, luminance, hexLuminance };
