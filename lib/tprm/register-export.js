'use strict';

const placement = require('./placement');
const labels = require('./labels');

const BOM = '﻿';
const RISKY_START = /^[=+\-@\t\r]/;

function cell(value) {
  let s = value == null ? '' : String(value);
  if (RISKY_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(header, rows) {
  return BOM + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

function fileName(prefix, clientName, today) {
  const slug = String(clientName || 'client').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'client';
  return `${prefix}-${slug}-${today}.csv`;
}

function spendOf(services, fallbackCurrency) {
  const totals = new Map();
  for (const s of services) {
    if (s.annual_spend == null || s.annual_spend === '') continue;
    const cur = s.spend_currency || fallbackCurrency;
    totals.set(cur, (totals.get(cur) || 0) + Number(s.annual_spend));
  }
  return [...totals].map(([cur, n]) => `${cur} ${Number(n.toFixed(2))}`).join('; ');
}

const FIRM_HEADER = ['Name', 'Status', 'Tier', 'Tier source', 'Next review date', 'Due', 'Open assessment stage', 'Open findings',
  'Owner', 'Services', 'Annual spend'];

async function firmRegister(db, actor, query = {}) {
  const register = require('./register');
  const list = await register.listThirdParties(db, actor, query);
  const approvals = await require('./decisions').approvals(db, actor.ws);
  const stages = await require('./pipeline').stagesForClient(db, actor.ws.id);
  const extras = await require('./register-hub').extras(db, actor.ws.id);
  const ids = list.rows.map(r => Number(r.id));
  const services = ids.length ? await db.prepare(`SELECT third_party_id, description, annual_spend, spend_currency FROM tp_services
    WHERE workspace_id = ? AND third_party_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(actor.ws.id, ...ids) : [];
  const byParty = new Map();
  for (const s of services) {
    const k = Number(s.third_party_id);
    if (!byParty.has(k)) byParty.set(k, []);
    byParty.get(k).push(s);
  }
  const fallback = await register.defaultCurrency(db, actor.ws.firm_id);
  const rows = list.rows.map(r => {
    const id = Number(r.id);
    const ap = approvals.get(id);
    const stage = stages.get(id);
    const x = extras.get(id) || {};
    const own = byParty.get(id) || [];
    const due = r.status === 'in_use'
      ? labels.due({ nextDueDate: r.next_due_date, lastAssessmentDate: r.last_assessment_date, inProgress: !!(ap && ap.openAssessment), today: list.today })
      : null;
    return [
      r.name, placement.STATUS_LABELS[r.status] || r.status,
      r.current_tier ? placement.TIER_LABELS[r.current_tier] : labels.TIER_NEEDED,
      r.tier_source ? placement.TIER_SOURCE_LABELS[r.tier_source] || r.tier_source : '',
      r.next_due_date || '', due ? due.label : '',
      stage ? stage.step : 'None open',
      Number(x.open_findings) || 0,
      x.owner_name || '',
      own.map(s => s.description).filter(Boolean).join('; '),
      spendOf(own, fallback),
    ];
  });
  return { header: FIRM_HEADER, rows, today: list.today };
}

const CLIENT_HEADER = ['Third party', 'Service type', 'Tier', 'Stage', 'Decision', 'Residual risk', 'Open issues', 'Conditions done', 'Next review', 'Owner'];

async function clientRegister(db, ws, query = {}, user = null) {
  const home = await require('./client-view').home(db, ws, query, user);
  const rows = home.allRows.map(r => {
    const ap = r.approval || {};
    const rec = r.recommendation;
    const due = r.status === 'in_use' ? labels.due({ nextDueDate: r.next_due_date, lastAssessmentDate: r.last_assessment_date, inProgress: !!ap.openAssessment, today: home.today }) : null;
    const decision = [ap.pending ? ap.pendingLabel : ap.label, ap.conditions && !ap.pending && ap.conditions.state !== 'met' ? ap.conditions.label : null].filter(Boolean).join('. ');
    return [
      r.name, r.category || '',
      r.current_tier ? placement.TIER_LABELS[r.current_tier] + (r.tier_source === 'provisional_from_client_label' ? ' (provisional)' : '') : '',
      r.stage.label, decision,
      rec && rec.residual_rating ? placement.TIER_LABELS[rec.residual_rating] || rec.residual_rating : '',
      rec ? Number(rec.open_findings) || 0 : '',
      rec && rec.conditions ? `${rec.conditions_done} of ${rec.conditions}` : '',
      due && due.label && !['in_progress', 'not_assessed'].includes(due.key) ? due.label : '',
      r.owner_name || '',
    ];
  });
  return { header: CLIENT_HEADER, rows, today: home.today };
}

module.exports = { cell, csv, fileName, firmRegister, clientRegister };
