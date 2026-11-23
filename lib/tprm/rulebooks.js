'use strict';

const access = require('./access');
const { TprmError } = require('./errors');

const SETTINGS_PERMISSION = 'tp.settings';
const STATUSES = Object.freeze(['active', 'watch', 'pending']);
const STATUS_LABELS = Object.freeze({ active: 'Active', watch: 'Watch list', pending: 'Pending' });
const LIMITS = Object.freeze({ referenceText: 2000, researchNote: 2000, questionIds: 200, questionText: 4000 });

const table = require('../../data/tprm-rulebooks');
const { TAG_FIN, TAG_RBI, TAG_IND, CONTRACT_TAGS, RULEBOOK_TABLE, NOT_CLIENT_FACING, parseQuestionIds, statusFrom, exitPlanFrom, tableEntry, seedRows } = table;

const DATA_LOCATION_QUESTIONS = Object.freeze({
  'RBI-02': Object.freeze({ country: 'IN', flagOn: Object.freeze(['no', 'partial']) }),
  'SEB-05': Object.freeze({ country: 'IN', where: true }),
  'UAE-01': Object.freeze({ country: 'AE', flagOn: Object.freeze(['no', 'partial']) }),
  'UAE-02': Object.freeze({ country: 'AE', flagOn: Object.freeze(['yes', 'partial']) }),
  'SAM-01': Object.freeze({ country: 'SA', where: true }),
});

const FINDING_CONTROL = 'A.5.31';

const notFound = () => new TprmError(404, 'This rulebook does not exist, or it is not available to your account.');
const invalid = errors => new TprmError(400, errors.join(' '), { errors });
const str = value => (Array.isArray(value) ? String(value[0] ?? '') : value == null ? '' : String(value)).trim();
const checked = value => ['1', 'on', 'true', 'yes'].includes(str(value).toLowerCase());
const list = value => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(v => String(v));

const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'AN', 'UK', 'XA', 'XB']);
const ALIASES = Object.freeze({
  uk: 'GB', 'great britain': 'GB', britain: 'GB', england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  usa: 'US', us: 'US', 'united states of america': 'US', america: 'US',
  uae: 'AE', emirates: 'AE', dubai: 'AE', 'abu dhabi': 'AE', sharjah: 'AE',
  ksa: 'SA', saudi: 'SA', 'kingdom of saudi arabia': 'SA', riyadh: 'SA', jeddah: 'SA', dammam: 'SA',
  bharat: 'IN', mumbai: 'IN', delhi: 'IN', 'new delhi': 'IN', bengaluru: 'IN', bangalore: 'IN', hyderabad: 'IN',
  chennai: 'IN', pune: 'IN', kolkata: 'IN', noida: 'IN', gurugram: 'IN', gurgaon: 'IN', 'gift city': 'IN',
  'south korea': 'KR', korea: 'KR', holland: 'NL', netherlands: 'NL', 'czech republic': 'CZ', russia: 'RU', vietnam: 'VN',
  turkey: 'TR', 'hong kong': 'HK', macau: 'MO', 'ivory coast': 'CI',
  'us east': 'US', 'us west': 'US', virginia: 'US', 'northern virginia': 'US', oregon: 'US', ohio: 'US', california: 'US',
  'new jersey': 'US', texas: 'US',
  frankfurt: 'DE', london: 'GB', dublin: 'IE', paris: 'FR', amsterdam: 'NL', tokyo: 'JP', sydney: 'AU', jakarta: 'ID',
  gbr: 'GB', ind: 'IN', are: 'AE', sau: 'SA', sgp: 'SG', deu: 'DE', fra: 'FR', irl: 'IE', nld: 'NL', aus: 'AU',
  can: 'CA', jpn: 'JP', che: 'CH', hkg: 'HK', chn: 'CN',
});
const TEXT_UPPER_ALIASES = Object.freeze({ UK: 'GB', US: 'US', USA: 'US', UAE: 'AE', KSA: 'SA', EU: null, EEA: null });

const normalName = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^the /, '');

let countryData = null;
function countryTable() {
  if (countryData) return countryData;
  const names = new Map();
  const lookup = new Map();
  let display = null;
  try { display = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) { display = null; }
  for (let a = 65; a < 91; a += 1) {
    for (let b = 65; b < 91; b += 1) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name = null;
      try { name = display ? display.of(code) : null; } catch (_) { name = null; }
      if (!name || name === code || /unknown/i.test(name)) continue;
      names.set(code, name);
      lookup.set(normalName(name), code);
      const plain = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\bSAR\b.*$/, '').trim();
      if (plain && plain !== name) lookup.set(normalName(plain), code);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) lookup.set(alias, code);
  const textTerms = [...lookup.entries()].filter(([term]) => term.length >= 4)
    .sort((x, y) => y[0].length - x[0].length)
    .map(([term, code]) => ({ code, re: new RegExp(`(^| )${term.replace(/ /g, ' ')}( |$)`) }));
  countryData = { names, lookup, textTerms };
  return countryData;
}

function countryName(code) {
  return countryTable().names.get(String(code || '').toUpperCase()) || null;
}

function countryOptions() {
  return [...countryTable().names.entries()].map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isCountryCode(code) {
  return countryTable().names.has(String(code || ''));
}

function normaliseCountry(token) {
  const raw = String(token == null ? '' : token).trim();
  if (!raw) return null;
  const { names, lookup } = countryTable();
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const code = raw.toUpperCase();
    if (names.has(code)) return code;
  }
  const key = normalName(raw);
  if (lookup.has(key)) return lookup.get(key);
  const outside = normalName(raw.replace(/\(.*?\)/g, ' '));
  if (outside && lookup.has(outside)) return lookup.get(outside);
  const inside = (raw.match(/\((.*?)\)/) || [])[1];
  if (inside && lookup.has(normalName(inside))) return lookup.get(normalName(inside));
  return null;
}

function hostingCountries(text) {
  const codes = [];
  const unknown = [];
  const add = code => { if (!codes.includes(code)) codes.push(code); };
  for (const part of String(text == null ? '' : text).split(/[,;/\n]+/).map(p => p.trim()).filter(Boolean)) {
    const code = normaliseCountry(part);
    if (code) { add(code); continue; }
    const pieces = part.split(/\s+(?:and|&)\s+/i).map(p => p.trim()).filter(Boolean);
    const found = pieces.length > 1 ? pieces.map(normaliseCountry) : [null];
    if (found.every(Boolean)) found.forEach(add);
    else unknown.push(part);
  }
  return { codes, unknown };
}

function countriesInText(text) {
  const raw = String(text == null ? '' : text);
  const norm = normalName(raw);
  const found = [];
  if (!norm) return found;
  let rest = ` ${norm} `;
  for (const { code, re } of countryTable().textTerms) {
    if (re.test(rest.trim())) {
      if (!found.includes(code)) found.push(code);
      rest = rest.replace(re, ' ');
    }
  }
  for (const [word, code] of Object.entries(TEXT_UPPER_ALIASES)) {
    if (code && new RegExp(`\\b${word}\\b`).test(raw) && !found.includes(code)) found.push(code);
  }
  return found;
}

function tagsOf(rulebooks) {
  const out = [];
  for (const rb of rulebooks || []) for (const t of rb.contract_tags || []) if (!out.includes(t)) out.push(t);
  return out;
}

function dataCountriesOf(rulebooks) {
  const out = [];
  for (const rb of rulebooks || []) {
    if (!rb.data_country) continue;
    let entry = out.find(e => e.country === rb.data_country);
    if (!entry) { entry = { country: rb.data_country, name: countryName(rb.data_country) || rb.data_country, rulebooks: [] }; out.push(entry); }
    if (!entry.rulebooks.includes(rb.name)) entry.rulebooks.push(rb.name);
  }
  return out;
}

const namesOf = codes => codes.map(c => countryName(c) || c);

function serviceFlags(services, countries) {
  const flags = [];
  const unrecorded = [];
  const unrecognised = [];
  if (!countries.length) return { flags, unrecorded, unrecognised };
  for (const s of services || []) {
    const { codes, unknown } = hostingCountries(s.hosting_countries);
    if (!codes.length && !unknown.length) { unrecorded.push({ service_id: Number(s.id), description: s.description }); continue; }
    if (unknown.length) unrecognised.push({ service_id: Number(s.id), description: s.description, unknown });
    for (const req of countries) {
      const outside = codes.filter(c => c !== req.country);
      if (!outside.length) continue;
      flags.push({
        kind: 'service', service_id: Number(s.id), description: s.description, country: req.country, country_name: req.name,
        rulebooks: req.rulebooks, outside, outside_names: namesOf(outside), unknown, hosting: s.hosting_countries,
      });
    }
  }
  return { flags, unrecorded, unrecognised };
}

function answerFlags(answers, countries) {
  const flags = [];
  const required = new Map(countries.map(c => [c.country, c]));
  for (const a of answers || []) {
    const rule = DATA_LOCATION_QUESTIONS[a.question_id];
    if (!rule || !required.has(rule.country)) continue;
    const req = required.get(rule.country);
    const named = countriesInText(a.detail);
    const outside = named.filter(c => c !== rule.country);
    let reason = null;
    if (rule.where) {
      if (outside.length) reason = 'names_other_country';
      else if (!named.length && a.response !== 'na') reason = 'no_country_named';
    } else if (rule.flagOn.includes(a.response)) {
      reason = 'response';
    }
    if (!reason) continue;
    flags.push({
      kind: 'answer', answer_id: Number(a.id), question_id: a.question_id, response: a.response, detail: a.detail || null,
      country: rule.country, country_name: req.name, rulebooks: req.rulebooks, reason, outside, outside_names: namesOf(outside),
    });
  }
  return flags;
}

const RB_COLUMNS = `r.id, r.firm_id, r.key, r.position, r.name, r.applies_to, r.status, r.bank_entry, r.question_ids,
  r.contract_tags, r.exit_plan_required, r.data_country, r.reference_text, r.research_note, r.enabled, r.version, r.updated_by, r.created_at,
  r.updated_at, r.row_version`;

const tickable = rb => !!rb && rb.status === 'active' && !!rb.enabled;

function notTickableReason(rb) {
  if (rb.status === 'watch') return 'On the watch list: not binding yet, so it cannot be ticked.';
  if (rb.status === 'pending') return 'Pending: its rules are not issued yet, so it cannot be ticked.';
  if (!rb.enabled) return 'Switched off by your firm.';
  return null;
}

async function listForFirm(db, firmId) {
  return await db.prepare(`SELECT ${RB_COLUMNS}, u.name AS updated_by_name FROM tp_rulebooks r
    LEFT JOIN users u ON u.id = r.updated_by WHERE r.firm_id = ? ORDER BY r.position, r.id`).all(Number(firmId));
}

async function getRulebook(db, firmId, id, { forUpdate = false } = {}) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return (await db.prepare(`SELECT ${RB_COLUMNS} FROM tp_rulebooks r WHERE r.firm_id = ? AND r.id = ?${forUpdate ? ' FOR UPDATE' : ''}`)
    .get(Number(firmId), n)) || null;
}

async function versionsOf(db, firmId, rulebookId) {
  return await db.prepare(`SELECT v.id, v.version, v.question_ids, v.contract_tags, v.exit_plan_required, v.data_country,
      v.reference_text, v.enabled, v.created_by, v.created_at, u.name AS created_by_name
    FROM tp_rulebook_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.firm_id = ? AND v.rulebook_id = ? ORDER BY v.version DESC`).all(Number(firmId), Number(rulebookId));
}

async function clientCount(db, firmId, rulebookId) {
  return (await db.prepare('SELECT COUNT(*)::integer AS c FROM tp_client_rulebooks WHERE firm_id = ? AND rulebook_id = ?')
    .get(Number(firmId), Number(rulebookId))).c;
}

function snapshot(rb, versionId) {
  return {
    rulebook_id: Number(rb.id), version_id: Number(versionId), key: rb.key, name: rb.name, version: Number(rb.version),
    question_ids: [...(rb.question_ids || [])], contract_tags: [...(rb.contract_tags || [])],
    exit_plan_required: !!rb.exit_plan_required, data_country: rb.data_country || null,
  };
}

async function currentForClient(db, workspaceId) {
  const rows = await db.prepare(`SELECT ${RB_COLUMNS}, v.id AS version_id FROM tp_client_rulebooks c
    JOIN tp_rulebooks r ON r.firm_id = c.firm_id AND r.id = c.rulebook_id
    JOIN tp_rulebook_versions v ON v.rulebook_id = r.id AND v.version = r.version
    WHERE c.workspace_id = ? AND r.status = 'active' AND r.enabled ORDER BY r.position, r.id`).all(Number(workspaceId));
  return rows.map(r => snapshot(r, r.version_id));
}

async function forAssessment(db, actor, assessment) {
  const q = await db.prepare('SELECT id, rulebooks FROM tp_questionnaires WHERE workspace_id = ? AND assessment_id = ?')
    .get(actor.ws.id, assessment.id);
  if (q) return { source: 'questionnaire', rulebooks: Array.isArray(q.rulebooks) ? q.rulebooks : [] };
  return { source: 'client', rulebooks: await currentForClient(db, actor.ws.id) };
}

async function exitPlanRulebooks(db, actor, assessment) {
  const effective = await forAssessment(db, actor, assessment);
  const required = effective.rulebooks.filter(r => r && r.exit_plan_required);
  if (!required.length) return [];
  const ids = required.map(r => Number(r.rulebook_id)).filter(n => Number.isSafeInteger(n) && n > 0);
  const texts = ids.length
    ? await db.prepare(`SELECT id, reference_text FROM tp_rulebooks WHERE firm_id = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(Number(actor.ws.firm_id), ...ids)
    : [];
  const byId = new Map(texts.map(t => [Number(t.id), t.reference_text]));
  return required.map(r => ({ key: r.key, name: r.name, version: Number(r.version), reference_text: byId.get(Number(r.rulebook_id)) || null }));
}

async function clientPanel(db, actor) {
  if (!actor || !actor.ws || !access.isFirmUser(actor.user)) return null;
  const firmRows = await listForFirm(db, actor.ws.firm_id);
  const ticks = await db.prepare(`SELECT c.rulebook_id, c.ticked_at, u.name AS ticked_by_name FROM tp_client_rulebooks c
    LEFT JOIN users u ON u.id = c.ticked_by WHERE c.workspace_id = ?`).all(actor.ws.id);
  const byId = new Map(ticks.map(t => [Number(t.rulebook_id), t]));
  const rulebooks = firmRows.map(rb => ({
    ...rb, tick: byId.get(Number(rb.id)) || null, tickable: tickable(rb), reason: notTickableReason(rb),
    country_name: rb.data_country ? countryName(rb.data_country) : null,
  }));
  return {
    rulebooks,
    fingerprint: fingerprint(ticks.map(t => Number(t.rulebook_id))),
    canEdit: access.can(actor.user, actor.perms, SETTINGS_PERMISSION),
    STATUS_LABELS,
  };
}

const fingerprint = ids => [...new Set(ids.map(Number))].sort((a, b) => a - b).join(',') || 'none';

function requireFirmSettings(user) {
  if (!access.isFirmUser(user) || !user.firm_id || !access.firmCan(user, SETTINGS_PERMISSION)) {
    throw new TprmError(403, 'Rulebooks can be changed by managers only.');
  }
}

async function packOptions(db) {
  const bank = await latestBank(db);
  const packs = [];
  for (const q of bank.questions || []) {
    if (q.set !== 'Rulebook pack') continue;
    let p = packs.find(x => x.pack === q.pack);
    if (!p) { p = { pack: q.pack, questions: [] }; packs.push(p); }
    p.questions.push({ id: q.id, question: String(q.question || '').replace(/<Client>/g, 'the client') });
  }
  return packs;
}

async function latestBank(db) {
  const q = require('./questionnaires');
  const v = await q.latestBankVersion(db);
  return v ? await q.bankContent(db, v.id) : { questions: [] };
}

async function update(db, user, rulebookId, input = {}) {
  requireFirmSettings(user);
  const bank = await latestBank(db);
  const known = new Set((bank.questions || []).map(q => q.id));
  const errors = [];
  const idsText = Array.isArray(input.question_ids) ? input.question_ids.map(x => String(x).trim()).filter(Boolean).join(', ') : str(input.question_ids);
  if (idsText.length > LIMITS.questionText) errors.push(`The question ids must be ${LIMITS.questionText} characters or fewer.`);
  const parsed = parseQuestionIds(idsText, known);
  if (parsed.invalid.length) errors.push(`These are not question ids: ${parsed.invalid.slice(0, 5).join('; ')}.`);
  if (parsed.unknown.length) errors.push(`These questions are not in the question bank: ${parsed.unknown.slice(0, 10).join(', ')}.`);
  if (parsed.ids.length > LIMITS.questionIds) errors.push(`A rulebook can list at most ${LIMITS.questionIds} questions.`);
  const country = str(input.data_country).toUpperCase() || null;
  if (country && !isCountryCode(country)) errors.push('Choose the country from the list, or none.');
  const reference = str(input.reference_text) || null;
  if (reference && reference.length > LIMITS.referenceText) errors.push(`The reference text must be ${LIMITS.referenceText} characters or fewer.`);
  if (reference && NOT_CLIENT_FACING.test(reference)) {
    errors.push('The reference text is read by the client: keep links and research remarks ("verify", "unverified", "pending", "TODO") in the research note.');
  }
  const note = input.research_note === undefined ? undefined : (str(input.research_note) || null);
  if (note && note.length > LIMITS.researchNote) errors.push(`The research note must be ${LIMITS.researchNote} characters or fewer.`);
  if (errors.length) throw invalid(errors);
  const values = {
    enabled: checked(input.enabled), question_ids: parsed.ids, exit_plan_required: checked(input.exit_plan_required),
    data_country: country, reference_text: reference,
  };
  return await db.transaction(async () => {
    const rb = await getRulebook(db, user.firm_id, rulebookId, { forUpdate: true });
    if (!rb) throw notFound();
    const rowVersion = Number(input.row_version);
    if (!Number.isInteger(rowVersion) || rowVersion !== Number(rb.row_version)) {
      throw new TprmError(409, 'Someone else changed this rulebook after you opened it. Nothing was saved: reload the page and make your change again.');
    }
    const before = {};
    const after = {};
    for (const [k, v] of Object.entries(values)) {
      const was = k === 'question_ids' ? (rb[k] || []) : (rb[k] == null ? null : rb[k]);
      if (JSON.stringify(was) !== JSON.stringify(v)) { before[k] = was; after[k] = v; }
    }
    const versioned = Object.keys(after).length > 0;
    const noteChanged = note !== undefined && (rb.research_note || null) !== note;
    if (!versioned && !noteChanged) return { changed: false, rulebook: rb };
    if (noteChanged) { before.research_note = rb.research_note || null; after.research_note = note; }
    const res = await db.prepare(`UPDATE tp_rulebooks SET enabled = ?, question_ids = ?::jsonb, exit_plan_required = ?,
        data_country = ?, reference_text = ?, research_note = ?, version = version + ?, updated_by = ?, updated_at = now(),
        row_version = row_version + 1
      WHERE firm_id = ? AND id = ? AND row_version = ?`)
      .run(values.enabled, JSON.stringify(values.question_ids), values.exit_plan_required, values.data_country, values.reference_text,
        noteChanged ? note : (rb.research_note || null), versioned ? 1 : 0,
        Number(user.id), Number(user.firm_id), rb.id, rb.row_version);
    if (res.changes !== 1) throw new TprmError(409, 'Someone else changed this rulebook after you opened it. Nothing was saved: reload the page and make your change again.');
    const saved = await getRulebook(db, user.firm_id, rb.id);
    return { changed: true, versioned, rulebook: saved, before, after, version: Number(saved.version) };
  })();
}

async function setClientTicks(db, actor, input = {}) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, SETTINGS_PERMISSION) || !access.isFirmUser(actor.user)) {
    throw new TprmError(403, 'Only a manager can change the rulebooks of this client.');
  }
  const wanted = new Set();
  for (const raw of list(input.rulebook)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) throw invalid(['Choose rulebooks from the list.']);
    wanted.add(n);
  }
  return await db.transaction(async () => {
    await db.prepare('SELECT workspace_id FROM tp_client_settings WHERE workspace_id = ? FOR UPDATE').get(actor.ws.id);
    const firmRows = await listForFirm(db, actor.ws.firm_id);
    const byId = new Map(firmRows.map(r => [Number(r.id), r]));
    const current = (await db.prepare('SELECT rulebook_id FROM tp_client_rulebooks WHERE workspace_id = ?').all(actor.ws.id))
      .map(r => Number(r.rulebook_id));
    if (str(input.fingerprint) !== fingerprint(current)) {
      throw new TprmError(409, 'Someone else changed this client\'s rulebooks after you opened the page. Nothing was saved: reload the page and make your change again.');
    }
    const errors = [];
    for (const id of wanted) {
      const rb = byId.get(id);
      if (!rb) { errors.push('Choose rulebooks from the list.'); continue; }
      if (!current.includes(id) && !tickable(rb)) errors.push(`"${rb.name}" cannot be ticked: ${notTickableReason(rb)}`);
    }
    if (errors.length) throw invalid([...new Set(errors)]);
    const added = [...wanted].filter(id => !current.includes(id)).map(id => byId.get(id));
    const removed = current.filter(id => !wanted.has(id)).map(id => byId.get(id)).filter(Boolean);
    for (const rb of added) {
      await db.prepare(`INSERT INTO tp_client_rulebooks (workspace_id, firm_id, rulebook_id, rulebook_key, ticked_by)
        VALUES (?, ?, ?, ?, ?)`).run(actor.ws.id, Number(actor.ws.firm_id), rb.id, rb.key, Number(actor.user.id));
    }
    for (const rb of removed) {
      await db.prepare('DELETE FROM tp_client_rulebooks WHERE workspace_id = ? AND rulebook_id = ?').run(actor.ws.id, rb.id);
    }
    if (added.length || removed.length) await require('./exit-plans').syncWorkspace(db, actor, 'client_rulebooks_changed');
    return { added, removed };
  })();
}

async function submittedAnswers(db, workspaceId, assessmentId) {
  const ids = Object.keys(DATA_LOCATION_QUESTIONS);
  return await db.prepare(`SELECT a.id, a.question_id, a.response, a.detail FROM tp_answers a
    JOIN tp_questionnaires q ON q.workspace_id = a.workspace_id AND q.id = a.questionnaire_id
    WHERE a.workspace_id = ? AND q.assessment_id = ? AND a.submitted_at IS NOT NULL
      AND a.question_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.question_id`).all(workspaceId, assessmentId, ...ids);
}

async function servicesOf(db, workspaceId, thirdPartyId) {
  return await db.prepare(`SELECT id, description, hosting_countries FROM tp_services
    WHERE workspace_id = ? AND third_party_id = ? ORDER BY id`).all(workspaceId, Number(thirdPartyId));
}

async function thirdPartyPanel(db, actor, thirdPartyId) {
  const rulebooks = await currentForClient(db, actor.ws.id);
  const countries = dataCountriesOf(rulebooks);
  if (!countries.length) return null;
  const services = serviceFlags(await servicesOf(db, actor.ws.id, thirdPartyId), countries);
  return { source: 'client', countries, ...services };
}

async function assessmentPanel(db, actor, assessment) {
  const effective = await forAssessment(db, actor, assessment);
  const countries = dataCountriesOf(effective.rulebooks);
  if (!countries.length) return null;
  const services = serviceFlags(await servicesOf(db, actor.ws.id, assessment.third_party_id), countries);
  const answers = answerFlags(await submittedAnswers(db, actor.ws.id, assessment.id), countries);
  const assessments = require('./assessments');
  return {
    source: effective.source, countries, ...services, answerFlags: answers,
    canRaise: access.can(actor.user, actor.perms, 'tp.manage') && assessments.evidenceChangeable(assessment),
  };
}

const REASON_TEXT = Object.freeze({
  response: 'The answer says the data is not kept only in the required country.',
  names_other_country: 'The answer names another country.',
  no_country_named: 'The answer does not name the country where the data is kept.',
});

async function findingDraft(db, actor, assessment, query = {}) {
  const panel = await assessmentPanel(db, actor, assessment);
  if (!panel) throw new TprmError(404, 'No rulebook of this client requires data to stay in a country.');
  const country = str(query.country).toUpperCase();
  let flag = null;
  if (query.service) flag = panel.flags.find(f => f.service_id === Number(query.service) && f.country === country);
  else if (query.answer) flag = panel.answerFlags.find(f => f.answer_id === Number(query.answer) && f.country === country);
  if (!flag) throw new TprmError(404, 'This data-location flag no longer applies. Reload the assessment page.');
  const rulebookText = flag.rulebooks.join(', ');
  const lines = [`Data location: ${rulebookText} require${flag.rulebooks.length === 1 ? 's' : ''} the client's data to stay in ${flag.country_name}.`];
  let title;
  if (flag.kind === 'service') {
    title = `Data location: "${flag.description}" hosted outside ${flag.country_name}`;
    lines.push(`Service: ${flag.description}. Hosting countries recorded: ${flag.hosting}.`);
    lines.push(`Outside ${flag.country_name}: ${flag.outside_names.join(', ')}.`);
    if (flag.unknown.length) lines.push(`Not recognised as countries: ${flag.unknown.join(', ')}.`);
  } else {
    title = `Data location: answer to ${flag.question_id} (${flag.country_name})`;
    lines.push(`Question ${flag.question_id}, answered ${flag.response || 'not answered'}. ${REASON_TEXT[flag.reason]}`);
    if (flag.outside_names.length) lines.push(`Countries named: ${flag.outside_names.join(', ')}.`);
    if (flag.detail) lines.push(`Detail: ${flag.detail}`);
  }
  return {
    flag,
    values: {
      control_ref: FINDING_CONTROL, severity: assessment.final_tier || 'medium', title: title.slice(0, 200),
      description: lines.join('\n').slice(0, 4000), status: 'open', evidence: [],
    },
  };
}

module.exports = {
  packOptions,
  SETTINGS_PERMISSION, STATUSES, STATUS_LABELS, LIMITS, CONTRACT_TAGS, TAG_FIN, TAG_RBI, TAG_IND, RULEBOOK_TABLE,
  DATA_LOCATION_QUESTIONS, FINDING_CONTROL, REASON_TEXT,
  parseQuestionIds, statusFrom, exitPlanFrom, tableEntry, seedRows,
  normaliseCountry, hostingCountries, countriesInText, countryName, countryOptions, isCountryCode,
  tagsOf, dataCountriesOf, serviceFlags, answerFlags, tickable, notTickableReason, fingerprint,
  listForFirm, getRulebook, versionsOf, clientCount, snapshot, currentForClient, forAssessment, exitPlanRulebooks, clientPanel,
  update, setClientTicks, thirdPartyPanel, assessmentPanel, findingDraft,
};
