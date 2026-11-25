'use strict';

const access = require('./access');
const placement = require('./placement');

const subprocessors = () => require('./subprocessors');

const DIMENSIONS = Object.freeze(['third_party', 'category', 'country', 'tier', 'sole_source']);
const DIMENSION_LABELS = Object.freeze({
  third_party: 'By third party',
  category: 'By category',
  country: 'By hosting country',
  tier: 'By current tier',
  sole_source: 'By sole source',
});
const NONE = Object.freeze({
  category: 'No category',
  country: 'Hosting country not recorded',
  tier: 'Tier needed',
});
const TIER_ORDER = ['critical', 'high', 'medium', 'low', null];

const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const keyOf = s => norm(s).toLowerCase();

function splitCountries(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text == null ? '' : text).split(/[,;/\n]+/)) {
    const name = norm(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tierLabel = t => (t ? placement.TIER_LABELS[t] : NONE.tier);

function summarise(services, { firmWide = false } = {}) {
  const groups = Object.fromEntries(DIMENSIONS.map(d => [d, new Map()]));
  const add = (dimension, key, label, service, sort = null) => {
    const map = groups[dimension];
    if (!map.has(key)) map.set(key, { key, label, sort, services: [], parties: new Set(), clients: new Set() });
    const g = map.get(key);
    g.services.push(service);
    g.parties.add(partyKey(service));
    g.clients.add(Number(service.client_id));
  };
  const partyKey = s => (firmWide ? keyOf(s.third_party_name) : `id:${Number(s.third_party_id)}`);
  for (const s of services) {
    add('third_party', partyKey(s), norm(s.third_party_name), s);
    add('category', s.category ? keyOf(s.category) : '', s.category ? norm(s.category) : NONE.category, s);
    const countries = splitCountries(s.hosting_countries);
    if (!countries.length) add('country', '', NONE.country, s);
    for (const c of countries) add('country', c.toLowerCase(), c, s);
    add('tier', s.tier || '', tierLabel(s.tier), s, TIER_ORDER.indexOf(s.tier || null));
    add('sole_source', s.sole_source ? 'yes' : 'no', s.sole_source ? 'Sole source' : 'Not sole source', s, s.sole_source ? 0 : 1);
  }
  const total = services.length;
  const finish = (dimension) => [...groups[dimension].values()].map(g => ({
    key: g.key, label: g.label, count: g.services.length, thirdParties: g.parties.size, clients: g.clients.size,
    share: total ? g.services.length / total : 0, services: g.services, sort: g.sort, none: g.key === '',
  })).sort((a, b) => {
    if (a.sort != null && b.sort != null && a.sort !== b.sort) return a.sort - b.sort;
    if (a.none !== b.none) return a.none ? 1 : -1;
    return b.count - a.count || a.label.localeCompare(b.label);
  });
  const out = { total, thirdParties: groups.third_party.size, clients: new Set(services.map(s => Number(s.client_id))).size, groups: {} };
  for (const d of DIMENSIONS) out.groups[d] = finish(d);
  out.headlines = headlines(out, services, { firmWide, partyKey });
  return out;
}

function majorityProviders(services, partyKey) {
  const counts = new Map();
  for (const s of services) {
    const k = partyKey(s);
    if (!counts.has(k)) counts.set(k, { name: norm(s.third_party_name), count: 0 });
    counts.get(k).count += 1;
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const chosen = [];
  let covered = 0;
  for (const r of ranked) {
    if (covered * 2 > services.length) break;
    chosen.push(r);
    covered += r.count;
  }
  return { chosen, covered, distinct: ranked.length };
}

function headlines(summary, services, { firmWide, partyKey }) {
  const lines = [];
  const total = summary.total;
  if (!total) return lines;
  for (const tier of ['critical', 'high']) {
    const inTier = services.filter(s => s.tier === tier);
    if (!inTier.length) continue;
    const m = majorityProviders(inTier, partyKey);
    const names = m.chosen.length <= 3 ? ` (${m.chosen.map(c => c.name).join(', ')})` : '';
    lines.push({ key: `tier_${tier}`, accent: tier === 'critical',
      text: `${m.covered} of ${plural(inTier.length, `${placement.TIER_LABELS[tier]} service`, `${placement.TIER_LABELS[tier]} services`)} ${inTier.length === 1 ? 'depends' : 'depend'} on ${plural(m.chosen.length, 'third party', 'third parties')}${names}.` });
  }
  const top = summary.groups.third_party[0];
  if (top) {
    lines.push({ key: 'top_third_party', text: firmWide && top.clients > 1
      ? `${top.label} provides ${top.count} of ${plural(total, 'service', 'services')}, to ${top.clients} clients.`
      : `${top.label} provides ${top.count} of ${plural(total, 'service', 'services')}.` });
  }
  const country = summary.groups.country.find(g => !g.none);
  if (country) {
    lines.push({ key: 'top_country', text: `${country.count} of ${plural(total, 'service', 'services')} ${country.count === 1 ? 'is' : 'are'} hosted in ${country.label}.` });
  }
  const unrecorded = summary.groups.country.find(g => g.none);
  if (unrecorded) lines.push({ key: 'country_unrecorded', text: `${unrecorded.count} of ${plural(total, 'service', 'services')} ${unrecorded.count === 1 ? 'has' : 'have'} no hosting country recorded.` });
  const sole = services.filter(s => s.sole_source);
  const soleSerious = sole.filter(s => s.tier === 'critical' || s.tier === 'high').length;
  lines.push({ key: 'sole_source', text: sole.length
    ? `${sole.length} of ${plural(total, 'service', 'services')} ${sole.length === 1 ? 'is' : 'are'} sole source; ${soleSerious} of them ${soleSerious === 1 ? 'is' : 'are'} Critical or High tier.`
    : `None of the ${plural(total, 'service', 'services')} is marked sole source.` });
  return lines;
}

function fourthParties(rows, { firmWide = false, inUse = null } = {}) {
  const groups = new Map();
  const partyKey = r => (firmWide ? keyOf(r.third_party_name) : `id:${Number(r.third_party_id)}`);
  for (const r of rows) {
    const k = keyOf(r.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { key: k, label: norm(r.name), parties: new Map(), clients: new Set() });
    const g = groups.get(k);
    if (!g.parties.has(partyKey(r))) g.parties.set(partyKey(r), { third_party_id: Number(r.third_party_id), name: norm(r.third_party_name), client_id: Number(r.client_id), client_name: r.client_name || null });
    g.clients.add(Number(r.client_id));
  }
  const list = [...groups.values()].map(g => ({
    key: g.key, label: g.label, count: g.parties.size, clients: g.clients.size,
    thirdParties: [...g.parties.values()].sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const shared = list.filter(g => g.count > 1);
  const lines = shared.slice(0, 5).map(g => ({
    key: `fourth_${g.key}`,
    text: firmWide
      ? `${g.label} is a subprocessor of ${plural(g.count, 'third party', 'third parties')}${g.clients > 1 ? ` across ${g.clients} clients` : ''}.`
      : `An outage at ${g.label} affects ${g.count} of your ${plural(inUse == null ? g.count : inUse, 'third party', 'third parties')} in use (${g.thirdParties.map(t => t.name).join(', ')}).`,
  }));
  return { total: list.length, shared: shared.length, list, headlines: lines };
}

const SERVICE_SQL = `SELECT s.id, s.description, s.sole_source, s.hosting_countries, s.third_party_id,
    t.name AS third_party_name, t.category, t.current_tier AS tier, t.workspace_id AS client_id
  FROM tp_services s JOIN tp_third_parties t ON t.workspace_id = s.workspace_id AND t.id = s.third_party_id
  WHERE s.workspace_id = ? AND t.status = 'in_use' ORDER BY lower(t.name), t.id, s.id`;
const IN_USE_SQL = "SELECT COUNT(*)::integer AS c FROM tp_third_parties t WHERE t.workspace_id = ? AND t.status = 'in_use'";
const WITHOUT_SERVICES_SQL = `SELECT COUNT(*)::integer AS c FROM tp_third_parties t
  WHERE t.workspace_id = ? AND t.status = 'in_use'
    AND NOT EXISTS (SELECT 1 FROM tp_services s WHERE s.workspace_id = t.workspace_id AND s.third_party_id = t.id)`;

async function forClient(db, actor) {
  if (!actor || !actor.ws || !access.can(actor.user, actor.perms, 'tp.view')) return null;
  const name = actor.ws.brand_display_name || actor.ws.client_name;
  const scope = require('./scope');
  const own = await scope.filterFor(db, actor.user, 't');
  const services = (await scope.keep(db, actor.user, await db.prepare(SERVICE_SQL).all(actor.ws.id), { ws: 'client_id' })).map(s => ({ ...s, client_name: name }));
  const withoutServices = (await db.prepare(WITHOUT_SERVICES_SQL + own.sql).get(actor.ws.id, ...own.params)).c;
  const inUse = (await db.prepare(IN_USE_SQL + own.sql).get(actor.ws.id, ...own.params)).c;
  const fourth = fourthParties(await scope.keep(db, actor.user, (await subprocessors().inUseRows(db, actor.ws.id)).map(r => ({ ...r, workspace_id: actor.ws.id }))), { inUse });
  return { ...summarise(services), withoutServices, fourth };
}

async function forPortal(db, actor) {
  if (!actor || !actor.ws || !access.isClientUser(actor.user) || !access.can(actor.user, actor.perms, 'tp.client_view')) return null;
  const summary = summarise(await db.prepare(SERVICE_SQL).all(actor.ws.id));
  for (const d of DIMENSIONS) {
    summary.groups[d].forEach((g, i) => {
      if (d === 'third_party') g.key = `p${i + 1}`;
      g.services = g.services.map(s => ({ third_party_name: s.third_party_name, description: s.description }));
    });
  }
  const inUse = (await db.prepare(IN_USE_SQL).get(actor.ws.id)).c;
  const fourth = fourthParties(await subprocessors().inUseRows(db, actor.ws.id), { inUse });
  fourth.list = fourth.list.map((g, i) => ({ key: `f${i + 1}`, label: g.label, count: g.count, thirdParties: g.thirdParties.map(t => ({ name: t.name })) }));
  fourth.headlines = fourth.headlines.map((h, i) => ({ key: `fourth_${i + 1}`, text: h.text }));
  return { ...summary, withoutServices: (await db.prepare(WITHOUT_SERVICES_SQL).get(actor.ws.id)).c, fourth };
}

async function forFirm(deps, user) {
  if (!access.isManager(user) || !access.firmCan(user, 'tp.view')) return null;
  const { enabled } = await access.listFirmClients(deps, user);
  const services = [];
  const fourthRows = [];
  let withoutServices = 0;
  for (const c of enabled) {
    const loaded = await access.loadFirmWorkspace(deps, user, c.id);
    if (!loaded) continue;
    services.push(...(await deps.db.prepare(SERVICE_SQL).all(loaded.ws.id)).map(s => ({ ...s, client_name: c.name })));
    withoutServices += (await deps.db.prepare(WITHOUT_SERVICES_SQL).get(loaded.ws.id)).c;
    fourthRows.push(...(await subprocessors().inUseRows(deps.db, loaded.ws.id)).map(r => ({ ...r, client_name: c.name })));
  }
  return { ...summarise(services, { firmWide: true }), withoutServices, clientCount: enabled.length,
    fourth: fourthParties(fourthRows, { firmWide: true }) };
}

module.exports = { DIMENSIONS, DIMENSION_LABELS, NONE, splitCountries, summarise, majorityProviders, fourthParties, forClient, forPortal, forFirm };
