'use strict';

const RULES = Object.freeze([
  [/\bthe client's systems\b/g, 'your systems'],
  [/\bthe client's environment\b/g, 'your environment'],
  [/\bat client sites\b/g, 'at your sites'],
  [/\bclient sites\b/g, 'your sites'],
  [/\bhold client data\b/g, 'hold your data'],
  [/\bclient data\b/g, 'your data'],
  [/\bthe client's\b/g, 'your organisation\'s'],
  [/\bThe client's\b/g, 'Your organisation\'s'],
  [/\bthe client\b/g, 'your organisation'],
  [/\bThe client\b/g, 'Your organisation'],
]);

function forClient(text) {
  if (text == null) return text;
  let out = String(text);
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

function question(q) {
  if (!q || typeof q !== 'object') return q;
  return {
    ...q,
    text: forClient(q.text),
    answers: Array.isArray(q.answers) ? q.answers.map(a => (a && typeof a === 'object' ? { ...a, label: forClient(a.label) } : a)) : q.answers,
  };
}

module.exports = { forClient, question };
