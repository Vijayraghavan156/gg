'use strict';

const { workspaceTimeZone, normalizeTimeZone } = require('../dates');

const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDate(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(value, tz) {
  if (typeof value === 'string' && YMD.test(value)) {
    const m = value.match(YMD);
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  const d = toDate(value);
  if (!d) return null;
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: normalizeTimeZone(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d)) {
    if (p.type === 'year') out.y = Number(p.value);
    if (p.type === 'month') out.m = Number(p.value);
    if (p.type === 'day') out.d = Number(p.value);
  }
  return out;
}

function day(value, tz) {
  const p = parts(value, tz);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : '';
}

function ymd(value, tz) {
  const p = parts(value, tz);
  return p ? `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : '';
}

function zoneName(d, tz) {
  let fallback = '';
  for (const locale of ['en-IN', 'en-US', 'en-GB']) {
    const name = (new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(d)
      .find(p => p.type === 'timeZoneName') || {}).value || '';
    if (/^[A-Z]{2,5}$/.test(name)) return name;
    if (!fallback) fallback = name;
  }
  return fallback;
}

function time(value, tz, { zone = false } = {}) {
  const d = toDate(value);
  if (!d) return '';
  const zoneId = normalizeTimeZone(tz);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: zoneId, hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
    .replace(/\s+/g, ' ').replace(/\b(AM|PM)\b/, s => s.toLowerCase());
  return zone ? `${t} ${zoneName(d, zoneId)}` : t;
}

function dayTime(value, tz, opts = {}) {
  const d = toDate(value);
  if (!d) return '';
  return `${day(d, tz)}, ${time(d, tz, opts)}`;
}

function dayNumber(value) {
  const key = typeof value === 'string' && YMD.test(value) ? value : (toDate(value) ? toDate(value).toISOString().slice(0, 10) : null);
  if (!key) return null;
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function relative(value, today) {
  const a = dayNumber(value);
  const b = dayNumber(today);
  if (a == null || b == null) return '';
  const n = Math.round(a - b);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1) return `in ${n} days`;
  const late = -n;
  return `${late} day${late === 1 ? '' : 's'} overdue`;
}

const CURRENCIES = Object.freeze(['INR', 'GBP', 'USD', 'EUR', 'AED', 'SGD', 'AUD', 'CAD', 'CHF', 'HKD', 'JPY', 'SAR', 'ZAR']);
const DEFAULT_CURRENCY = 'INR';
const CURRENCY_LOCALE = Object.freeze({ INR: 'en-IN' });

function money(amount, currency = DEFAULT_CURRENCY) {
  if (amount == null || amount === '' || !Number.isFinite(Number(amount))) return '';
  const code = CURRENCIES.includes(currency) ? currency : DEFAULT_CURRENCY;
  return new Intl.NumberFormat(CURRENCY_LOCALE[code] || 'en-GB', { style: 'currency', currency: code, minimumFractionDigits: 0, maximumFractionDigits: 2 })
    .format(Number(amount));
}

function fileSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${v} byte${v === 1 ? '' : 's'}`;
  if (v < 1048576) return `${Math.round(v / 1024)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}

function zoneOf(ws, firm) {
  return workspaceTimeZone(ws, firm);
}

function forZone(zone, { ymdInZone = null, now = new Date() } = {}) {
  const tz = normalizeTimeZone(zone);
  const today = ymdInZone ? ymdInZone(now, tz) : ymd(now, tz);
  return Object.freeze({
    zone: tz,
    today,
    day: v => day(v, tz),
    dayTime: (v, opts) => dayTime(v, tz, { zone: true, ...(opts || {}) }),
    time: (v, opts) => time(v, tz, { zone: true, ...(opts || {}) }),
    relative: v => relative(v, today),
    ymd: v => ymd(v, tz),
    fileSize,
  });
}

module.exports = { MONTHS, CURRENCIES, DEFAULT_CURRENCY, money, day, dayTime, time, relative, fileSize, ymd, zoneOf, zoneName, forZone };
