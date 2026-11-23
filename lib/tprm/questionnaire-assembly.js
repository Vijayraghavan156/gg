'use strict';

const { REPORT_QUESTIONS } = require('./answer-rules');

const TIER_RANK = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });
const BANK_TIER_RANK = Object.freeze({ 'All tiers': 1, Low: 1, Medium: 2, High: 3, Critical: 4 });

const SETS = Object.freeze({ base: 'Base', module: 'Module', rulebook: 'Rulebook pack' });
const ALL_MODELS_TAG = 'All delivery models';
const CONSULTANT = 'Consultant';

const ALWAYS_INCLUDED = Object.freeze(['AIS-01']);

const DELIVERY_MODELS = Object.freeze(['vendor_hosted', 'client_hosted', 'non_technology', 'staff_in_client_environment']);
const DELIVERY_MODEL_LABELS = Object.freeze({
  vendor_hosted: 'Hosted or managed by the third party',
  client_hosted: "Software installed in the client's environment",
  non_technology: 'Non-technology service',
  staff_in_client_environment: "Third-party staff work inside the client's environment",
});
const BASE_SELECTION = Object.freeze({
  vendor_hosted: { tag: 'Vendor-hosted', flat: false },
  client_hosted: { tag: 'Client-hosted', flat: true },
  non_technology: { tag: 'Non-technology services', flat: true },
  staff_in_client_environment: { tag: 'Vendor-hosted', flat: false },
});
const DELIVERY_MODEL_NOTES = Object.freeze({
  staff_in_client_environment: 'The questions for third-party staff working inside the client\'s environment are still a draft and '
    + 'are switched off, so this third party gets the questionnaire for a service hosted or managed by the third party.',
});

const DELIVERY_QUESTION_ID = 'delivery_model';
const DELIVERY_ANSWER_TO_MODEL = Object.freeze({
  vendor_hosted: 'vendor_hosted',
  installed: 'client_hosted',
  non_technology: 'non_technology',
  staff_onsite: 'staff_in_client_environment',
});

const DISABLED_MODULES = Object.freeze(['Vendor Staff in Client Environment']);
const DYNAMIC_MODULES = Object.freeze([
  { module: 'AI Services', when: 'The third party answers Yes to AIS-01 (AI is used to provide the services).' },
]);

const MODULE_RULES = Object.freeze([
  { module: 'Personal Data & Privacy', question: 'data_handled', answers: ['personal', 'special_financial'],
    because: 'It handles personal, special-category, financial or payment data' },
  { module: 'Privileged Access & Managed Security', question: 'system_access', answers: ['privileged'],
    because: 'It has privileged, admin or network-connected access to the client\'s systems' },
  { module: 'Hosting Platform & Cloud Provider', deliveryModels: ['vendor_hosted', 'staff_in_client_environment'],
    because: 'The service is hosted or managed by the third party' },
  { module: 'Software & Application Security', deliveryModels: ['client_hosted'],
    because: 'It supplies software installed in the client\'s environment' },
  { module: 'Client-Hosted Software', deliveryModels: ['client_hosted'],
    because: 'It supplies software installed in the client\'s environment' },
  { module: 'Software & Application Security', question: 'supplies_software', answers: ['yes'],
    because: 'It supplies software or APIs that the client uses' },
  { module: 'Transaction & Client-Asset Systems', question: 'payments_records', answers: ['yes'],
    because: 'The service can create or change payments, trades, holdings or client-asset records' },
  { module: 'Physical & Data Centre', question: 'sites_data', answers: ['yes'],
    because: 'Its staff work at client sites, or it holds client data at its own sites' },
  { module: 'Non-Technology Services', deliveryModels: ['non_technology'],
    because: 'It provides a non-technology service' },
].map(Object.freeze));

const MODULE_FORMER_NAMES = Object.freeze({
  'Hosting Platform & Cloud Provider': Object.freeze(['Cloud & Hosting']),
});

function canonicalModule(name) {
  const n = String(name || '');
  for (const [current, former] of Object.entries(MODULE_FORMER_NAMES)) if (former.includes(n)) return current;
  return n;
}

const sameModule = (a, b) => canonicalModule(a) === canonicalModule(b);

function moduleNameIn(bank, name) {
  const catalog = moduleCatalog(bank);
  return catalog.find(m => sameModule(m, name)) || name;
}

class AssemblyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssemblyError';
  }
}

const questionsOf = bank => {
  const qs = bank && Array.isArray(bank.questions) ? bank.questions : null;
  if (!qs) throw new AssemblyError('The question bank has no questions.');
  return qs;
};

function parseDeliveryTags(value) {
  return String(value || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const m = part.match(/^(.*?)\s*\(all tiers\)$/i);
    return m ? { tag: m[1].trim(), flat: true } : { tag: part, flat: false };
  });
}

function rankOf(tier) {
  const rank = TIER_RANK[String(tier || '').toLowerCase()];
  if (!rank) throw new AssemblyError(`"${tier}" is not a tier.`);
  return rank;
}

function minRank(row) {
  const rank = BANK_TIER_RANK[row.min_tier];
  if (!rank) throw new AssemblyError(`Question ${row.id} has an unknown minimum tier "${row.min_tier}".`);
  return rank;
}

function moduleCatalog(bank) {
  const seen = [];
  for (const row of questionsOf(bank)) {
    if (row.set === SETS.module && row.pack && !seen.includes(row.pack)) seen.push(row.pack);
  }
  return seen;
}

function offeredModules(bank) {
  return moduleCatalog(bank).filter(m => !DISABLED_MODULES.includes(m));
}

function deliveryModelFromAnswers(answers) {
  const answer = answers && answers[DELIVERY_QUESTION_ID];
  return (answer && DELIVERY_ANSWER_TO_MODEL[answer]) || null;
}

function autoModules(answers, deliveryModel, bank = null) {
  const out = [];
  for (const rule of MODULE_RULES) {
    const hit = rule.deliveryModels
      ? rule.deliveryModels.includes(deliveryModel)
      : !!(answers && rule.answers.includes(answers[rule.question]));
    const module = bank ? moduleNameIn(bank, rule.module) : rule.module;
    if (hit && !out.some(m => m.module === module)) out.push({ module, because: rule.because });
  }
  return out;
}

function rulebookRowApplies(row, deliveryModel, tierRank) {
  if (minRank(row) > tierRank) return false;
  const tags = parseDeliveryTags(row.delivery_models);
  if (!tags.length || tags.some(t => /^any\b/i.test(t.tag) || t.tag === ALL_MODELS_TAG)) return true;
  return tags.some(t => t.tag === BASE_SELECTION[deliveryModel].tag);
}

function baseRowApplies(row, deliveryModel, tierRank) {
  if (ALWAYS_INCLUDED.includes(row.id)) return true;
  const selection = BASE_SELECTION[deliveryModel];
  const tags = parseDeliveryTags(row.delivery_models);
  const match = tags.find(t => t.tag === selection.tag || t.tag === ALL_MODELS_TAG);
  if (!match) return false;
  if (selection.flat || match.flat) return true;
  return minRank(row) <= tierRank;
}

function assemble(bank, { tier, deliveryModel, modules = [], rulebooks = [] } = {}) {
  const rows = questionsOf(bank);
  const tierRank = rankOf(tier);
  if (!DELIVERY_MODELS.includes(deliveryModel)) throw new AssemblyError(`"${deliveryModel}" is not a delivery model.`);
  const catalog = moduleCatalog(bank);
  for (const name of modules) {
    if (!catalog.includes(name)) throw new AssemblyError(`"${name}" is not a module of this question bank.`);
    if (DISABLED_MODULES.includes(name)) throw new AssemblyError(`The "${name}" module is switched off.`);
  }
  const chosenModules = new Set(modules);

  const baseByDomain = new Map();
  const moduleRows = new Map(catalog.filter(m => chosenModules.has(m)).map(m => [m, []]));
  const consultantChecks = [];
  for (const row of rows) {
    let kind = null;
    let title = null;
    if (row.set === SETS.base) {
      if (!baseRowApplies(row, deliveryModel, tierRank)) continue;
      kind = 'base';
      title = row.domain;
    } else if (row.set === SETS.module) {
      if (!chosenModules.has(row.pack) || minRank(row) > tierRank) continue;
      kind = 'module';
      title = row.pack;
    } else {
      continue;
    }
    if (row.answered_by === CONSULTANT) {
      consultantChecks.push({ id: row.id, kind, title });
      continue;
    }
    const target = kind === 'base' ? baseByDomain : moduleRows;
    if (!target.has(title)) target.set(title, []);
    target.get(title).push(row.id);
  }

  const sections = [];
  for (const [title, ids] of baseByDomain) sections.push({ kind: 'base', title, ids });
  for (const [title, ids] of moduleRows) if (ids.length) sections.push({ kind: 'module', title, ids });

  const byId = new Map(rows.map(row => [row.id, row]));
  const placed = new Set();
  for (const rb of rulebooks) {
    const title = typeof rb === 'string' ? rb : String((rb && rb.name) || '');
    const ids = typeof rb === 'string'
      ? rows.filter(row => row.set === SETS.rulebook && row.pack === rb).map(row => row.id)
      : [].concat((rb && rb.question_ids) || []);
    const own = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || row.set !== SETS.rulebook || placed.has(id) || !rulebookRowApplies(row, deliveryModel, tierRank)) continue;
      placed.add(id);
      if (row.answered_by === CONSULTANT) consultantChecks.push({ id: row.id, kind: 'rulebook', title });
      else own.push(row.id);
    }
    if (own.length) sections.push({ kind: 'rulebook', title, ids: own });
  }
  const present = new Set(sections.flatMap(s => s.ids));
  const order = new Map(rows.map((row, i) => [row.id, i]));
  const reportIds = Object.values(REPORT_QUESTIONS).map(r => r.question);
  const coverable = kinds => [...present].some(id => !reportIds.includes(id) && kinds.includes((byId.get(id) || {}).report_coverage));
  for (const [id, kinds] of [[REPORT_QUESTIONS.iso27001.question, ['iso', 'either', 'both']], [REPORT_QUESTIONS.soc2_type2.question, ['soc2', 'either', 'both']]]) {
    const row = byId.get(id);
    if (!row || present.has(id) || row.set !== SETS.base || row.answered_by === CONSULTANT || !coverable(kinds)) continue;
    let section = sections.find(x => x.kind === 'base' && x.title === row.domain);
    if (!section) {
      section = { kind: 'base', title: row.domain, ids: [] };
      sections.splice(sections.map(x => x.kind).lastIndexOf('base') + 1, 0, section);
    }
    section.ids.push(id);
    section.ids.sort((x, y) => (order.has(x) ? order.get(x) : Infinity) - (order.has(y) ? order.get(y) : Infinity));
    present.add(id);
  }
  const count = kind => sections.filter(s => s.kind === kind).reduce((n, s) => n + s.ids.length, 0);
  const byTitle = kind => Object.fromEntries(sections.filter(s => s.kind === kind).map(s => [s.title, s.ids.length]));
  return {
    sections,
    consultantChecks,
    counts: {
      base: count('base'),
      baseByDomain: byTitle('base'),
      modules: byTitle('module'),
      rulebooks: byTitle('rulebook'),
      vendorTotal: sections.reduce((n, s) => n + s.ids.length, 0),
      consultant: consultantChecks.length,
    },
  };
}

module.exports = {
  TIER_RANK, BANK_TIER_RANK, SETS, ALWAYS_INCLUDED, DELIVERY_MODELS, DELIVERY_MODEL_LABELS, BASE_SELECTION,
  DELIVERY_MODEL_NOTES, DELIVERY_QUESTION_ID, DELIVERY_ANSWER_TO_MODEL, DISABLED_MODULES, DYNAMIC_MODULES,
  MODULE_RULES, MODULE_FORMER_NAMES, AssemblyError,
  canonicalModule, sameModule, moduleNameIn, parseDeliveryTags, moduleCatalog, offeredModules, deliveryModelFromAnswers, autoModules, rulebookRowApplies, assemble,
};
