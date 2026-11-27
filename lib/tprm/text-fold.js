'use strict';

const fold = v => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const foldSql = expr => `lower(regexp_replace(normalize(COALESCE(${expr}, ''), NFD), '[\\u0300-\\u036f]', '', 'g'))`;
const likeFolded = q => `%${fold(q).replace(/[\\%_]/g, c => `\\${c}`)}%`;

module.exports = { fold, foldSql, likeFolded };
