'use strict';

const REFERENCE_TEXT_MAX = 2000;

const TAG_FIN = 'Financial-sector (shared)';
const TAG_RBI = 'RBI';
const TAG_IND = 'India baseline (CERT-In)';
const CONTRACT_TAGS = Object.freeze([TAG_FIN, TAG_RBI, TAG_IND]);

const IND = TAG_IND;
const RBI = [TAG_RBI, TAG_FIN, TAG_IND];
const INFIN = [TAG_FIN, TAG_IND];
const FIN = [TAG_FIN];
const RULEBOOK_TABLE = Object.freeze([
  { name: 'India baseline (CERT-In + DPDP)', key: 'india_baseline', tags: [IND], country: null },
  { name: 'RBI - Commercial Banks', key: 'rbi_commercial_banks', tags: RBI, country: 'IN' },
  { name: 'RBI - NBFCs (Middle Layer and above)', key: 'rbi_nbfc_middle_layer', tags: RBI, country: 'IN' },
  { name: 'RBI - NBFCs (Base Layer)', key: 'rbi_nbfc_base_layer', tags: RBI, country: null },
  { name: 'RBI - Payments Banks', key: 'rbi_payments_banks', tags: RBI, country: 'IN' },
  { name: 'RBI - Non-bank payment system operators', key: 'rbi_payment_system_operators', tags: RBI, country: 'IN' },
  { name: 'SEBI - CSCRF', key: 'sebi_cscrf', tags: INFIN, country: null },
  { name: 'SEBI - Stock exchanges and clearing corporations', key: 'sebi_mii', tags: INFIN, country: null },
  { name: 'IRDAI', key: 'irdai', tags: INFIN, country: null },
  { name: 'PFRDA', key: 'pfrda', tags: INFIN, country: null },
  { name: 'EU - GDPR', key: 'eu_gdpr', tags: [], country: null },
  { name: 'EU - DORA', key: 'eu_dora', tags: FIN, country: null },
  { name: 'EU - NIS2', key: 'eu_nis2', tags: [], country: null },
  { name: 'UK - UK GDPR', key: 'uk_gdpr', tags: [], country: null },
  { name: 'UK - PRA / FCA outsourcing', key: 'uk_pra_fca', tags: FIN, country: null },
  { name: 'PCI DSS', key: 'pci_dss', tags: [], country: null },
  { name: 'US - HIPAA', key: 'us_hipaa', tags: [], country: null },
  { name: 'US - GLBA Safeguards', key: 'us_glba', tags: FIN, country: null },
  { name: 'US - NYDFS Part 500', key: 'us_nydfs', tags: FIN, country: null },
  { name: 'US - Bank regulators', key: 'us_bank_regulators', tags: FIN, country: null },
  { name: 'US - SEC Regulation S-P', key: 'us_sec_reg_sp', tags: FIN, country: null },
  { name: 'Singapore - MAS', key: 'sg_mas', tags: FIN, country: null },
  { name: 'Singapore - PDPA', key: 'sg_pdpa', tags: [], country: null },
  { name: 'UAE - CBUAE banks', key: 'ae_cbuae', tags: FIN, country: 'AE' },
  { name: 'UAE - DIFC / ADGM data protection', key: 'ae_difc_adgm', tags: [], country: null },
  { name: 'UAE - Federal PDPL', key: 'ae_pdpl', tags: [], country: null },
  { name: 'Saudi Arabia - SAMA', key: 'sa_sama', tags: FIN, country: 'SA' },
  { name: 'Saudi Arabia - NCA ECC', key: 'sa_nca_ecc', tags: [], country: null },
  { name: 'Saudi Arabia - PDPL', key: 'sa_pdpl', tags: [], country: null },
  { name: 'AI rules watch list (not binding yet)', key: 'ai_watch_list', tags: [], country: null },
  { name: 'IFSCA', key: 'ifsca', tags: INFIN, country: null },
].map(Object.freeze));

const REFERENCES = Object.freeze({
  india_baseline: {
    reference: 'Required under the CERT-In Directions No. 20(3)/2022-CERT-In of 28 April 2022, the Digital Personal Data Protection Act, 2023 (section 8) and the Digital Personal Data Protection Rules, 2025',
    note: 'DPDP processor-related rules expected in force around May 2027; check the commencement date. CERT-In FAQs of May 2022 also apply.',
  },
  rbi_commercial_banks: {
    reference: 'Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Commercial Banks)',
    note: 'Directions of 28 Nov 2025. Paragraph references to verify before quoting them.',
  },
  rbi_nbfc_middle_layer: {
    reference: 'Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Non-Banking Financial Companies)',
    note: 'Directions of 28 Nov 2025 (NBFC version). Paragraph references to verify before quoting them.',
  },
  rbi_nbfc_base_layer: {
    reference: 'Required under the RBI Master Direction - Managing Risks in Outsourcing, 2025 (Non-Banking Financial Companies)',
    note: 'Directions of 28 Nov 2025 (NBFC version). Paragraph references to verify before quoting them.',
  },
  rbi_payments_banks: {
    reference: 'Required under the Reserve Bank of India\'s Master Directions applicable to Payments Banks',
    note: 'The bank gives only a link, no instrument title: confirm the exact Master Direction title and date before quoting it.',
  },
  rbi_payment_system_operators: {
    reference: 'Required under the Reserve Bank of India\'s framework for authorised non-bank payment system operators',
    note: 'Status in the bank: partly unverified. The bank cites a 2021 framework whose currency is unverified, and gives only a link: confirm the title and whether it is still current.',
  },
  sebi_cscrf: {
    reference: 'Required under the SEBI Cybersecurity and Cyber Resilience Framework (CSCRF) for SEBI Regulated Entities (circular SEBI/HO/ITD-1/ITD_CSC_EXT/P/CIR/2024/113 of 20 August 2024, as amended) and the SEBI guidelines on outsourcing by intermediaries (circular CIR/MIRSD/24/2011)',
    note: 'Amendments to Aug 2025 and the FAQ of 11 Jun 2025 also apply. The bank also cites the exchanges and clearing corporations circular SEBI/HO/MRD/DP/CIR/P/2017/101.',
  },
  sebi_mii: {
    reference: 'Required under the SEBI guidelines on outsourcing by stock exchanges and clearing corporations (circular SEBI/HO/MRD/DP/CIR/P/2017/101)',
    note: 'The bank also cites the intermediaries circular CIR/MIRSD/24/2011.',
  },
  irdai: {
    reference: 'Required under the IRDAI Master Circular on Operations and Allied Matters of Insurers (IRDAI/PPGR/CIR/MISC/97/06/2024) and the IRDAI Information and Cyber Security Guidelines, 2026 (IRDAI/GA&HR/CIR/MISC/51/4/2026)',
    note: 'Status in the bank: the repeal of the 2017 outsourcing regulation is unverified. Master Circular chapter III is the outsourcing chapter (to confirm). Cyber guidelines dated 6 Apr 2026.',
  },
  pfrda: {
    reference: 'Required under the PFRDA Guidelines on Outsourcing of Activities by Pension Funds (PFRDA/2017/30/PF/4)',
    note: 'Status in the bank: the PFRDA cloud policy was not opened; check it before relying on cloud-specific points.',
  },
  eu_gdpr: {
    reference: 'Required under the EU General Data Protection Regulation (Regulation (EU) 2016/679), Articles 28 and 33 and Chapter V',
    note: '',
  },
  eu_dora: {
    reference: 'Required under the EU Digital Operational Resilience Act (Regulation (EU) 2022/2554), Articles 28 to 30, and its regulatory technical standards on subcontracting (2025/532) and incident reporting (2025/301)',
    note: '',
  },
  eu_nis2: {
    reference: 'Required under the EU NIS2 Directive (Directive (EU) 2022/2555), Articles 21(2)(d) and 23',
    note: '',
  },
  uk_gdpr: {
    reference: 'Required under the UK GDPR and the Data Protection Act 2018, as amended by the Data (Use and Access) Act 2025',
    note: 'Status in the bank: partly unverified (which Data (Use and Access) Act 2025 provisions are in force). ICO international transfers guidance is the working source.',
  },
  uk_pra_fca: {
    reference: 'Required under PRA Supervisory Statement SS2/21 (Outsourcing and third party risk management) and the FCA outsourcing rules in SYSC 8',
    note: 'SS2/21 revised Mar 2026, effective 18 Mar 2027 (confirm). Also PRA PS7/26 / FCA PS26/2 and the UK critical third parties regime.',
  },
  pci_dss: {
    reference: 'Required under PCI DSS v4.0.1, Requirements 12.8 and 12.9',
    note: '',
  },
  us_hipaa: {
    reference: 'Required under HIPAA, 45 CFR 164.504(e) and 164.410',
    note: '',
  },
  us_glba: {
    reference: 'Required under the GLBA Safeguards Rule, 16 CFR 314.4(f) and (j)',
    note: '',
  },
  us_nydfs: {
    reference: 'Required under the NYDFS Cybersecurity Regulation, 23 NYCRR 500.11 and 500.17, and the DFS guidance on managing risks related to third-party service providers (21 October 2025)',
    note: '',
  },
  us_bank_regulators: {
    reference: 'Required under the Interagency Guidance on Third-Party Relationships (June 2023) and the bank incident notification rule, 12 CFR Part 53',
    note: 'A replacement of the 2023 interagency guidance was proposed in Sep 2026: check its status before relying on the 2023 text.',
  },
  us_sec_reg_sp: {
    reference: 'Required under SEC Regulation S-P, 17 CFR 248.30, as amended in 2024',
    note: '',
  },
  sg_mas: {
    reference: 'Required under MAS Notice 658, the MAS Guidelines on Outsourcing, MAS Notices FSM-N05 and FSM-N06 and the MAS Technology Risk Management Guidelines (2021)',
    note: 'Notice 658 and the Guidelines effective 11 Dec 2024.',
  },
  sg_pdpa: {
    reference: 'Required under the Singapore Personal Data Protection Act 2012 (sections 24 and 26 and Part 6A) and the PDPC Advisory Guidelines',
    note: 'PDPC Advisory Guidelines revised 29 Apr 2026.',
  },
  ae_cbuae: {
    reference: 'Required under the CBUAE Outsourcing Regulation for Banks (Circular No. 14/2021)',
    note: 'Status in the bank: partly unverified. A 2026 regulation requiring exit plans for material third parties, and a 4 h incident notice to CBUAE, are unverified.',
  },
  ae_difc_adgm: {
    reference: 'Required under the DIFC Data Protection Law (DIFC Law No. 5 of 2020) and the ADGM Data Protection Regulations 2021',
    note: 'DIFC law consolidated Jul 2025.',
  },
  ae_pdpl: {
    reference: 'Required under the UAE Federal Personal Data Protection Law',
    note: 'Status in the bank: watch, executive regulations not issued yet. The bank gives only a link: confirm the decree-law number and date before quoting it.',
  },
  sa_sama: {
    reference: 'Required under the SAMA Cyber Security Framework (2017) and the SAMA Rules on Outsourcing (2019)',
    note: 'Cyber Security Framework section 3.4 is the third-party section (to confirm).',
  },
  sa_nca_ecc: {
    reference: 'Required under the NCA Essential Cybersecurity Controls (ECC-2:2024), controls 4-1 and 4-2',
    note: '',
  },
  sa_pdpl: {
    reference: 'Required under the Saudi Arabia Personal Data Protection Law and its Implementing Regulations and Transfer Regulations',
    note: 'Status in the bank: transfer details partly unverified.',
  },
  ai_watch_list: {
    reference: 'Watch list, not binding yet: SEBI (Intermediaries) Regulations, regulation 16C, and AI guidance from RBI and CERT-In',
    note: 'The bank gives only links. Drafts and guidance tracked: RBI Model Risk Management draft (Jun 2026), SEBI AI/ML consultation (Jun 2025), RBI FREE-AI (Aug 2025), CERT-In AI Security Auditing Guidelines (Nov 2026), EU AI Act high-risk duties from 2 Dec 2027.',
  },
  ifsca: {
    reference: 'Required under the IFSCA Guidelines on Cyber Security and Cyber Resilience for Regulated Entities in IFSCs (IFSCA-CSD0MSC/13/2025-DCS, 10 March 2025)',
    note: 'Status in the bank: no cross-sector IFSCA outsourcing rule found.',
  },
});

function researchNote(key, source) {
  const ref = REFERENCES[key];
  const parts = [];
  if (ref && ref.note) parts.push(ref.note);
  if (source) parts.push(`Bank source: ${String(source).trim()}`);
  const text = parts.join(' ').trim();
  return text ? text.slice(0, REFERENCE_TEXT_MAX) : null;
}

const NOT_CLIENT_FACING = /verify|unverified|pending|todo|https?:/i;

function parseQuestionIds(text, known = null) {
  const out = { ids: [], unknown: [], invalid: [], notes: [] };
  const raw = String(text == null ? '' : text).trim();
  if (!raw || /^none\b/i.test(raw) || raw === '-') return out;
  const push = id => {
    if (known && !known.has(id)) { if (!out.unknown.includes(id)) out.unknown.push(id); return; }
    if (!out.ids.includes(id)) out.ids.push(id);
  };
  for (const part of raw.split(/[,;+\n]/).map(p => p.trim()).filter(Boolean)) {
    const range = part.match(/\b([A-Z]{2,4})-(\d{1,3})\s+to\s+([A-Z]{2,4})-(\d{1,3})\b/i);
    if (range) {
      const prefix = range[1].toUpperCase();
      const from = Number(range[2]);
      const to = Number(range[4]);
      if (prefix !== range[3].toUpperCase() || to < from || to - from > 100) { out.invalid.push(part); continue; }
      const width = range[2].length;
      for (let n = from; n <= to; n += 1) {
        const id = `${prefix}-${String(n).padStart(width, '0')}`;
        if (known && !known.has(id)) continue;
        push(id);
      }
      const rest = part.replace(range[0], '').replace(/[()]/g, ' ').trim();
      if (rest && !/^india baseline$/i.test(rest)) out.notes.push(part);
      continue;
    }
    const single = part.match(/\b([A-Z]{2,4})-(\d{1,3})\b/i);
    if (!single) { out.invalid.push(part); continue; }
    push(`${single[1].toUpperCase()}-${single[2]}`);
    if (part.replace(single[0], '').trim()) out.notes.push(part);
  }
  return out;
}

function statusFrom(text) {
  const t = String(text || '').trim();
  if (/^watch\b.*pending/i.test(t)) return 'pending';
  if (/^watch\b/i.test(t)) return 'watch';
  return 'active';
}

function exitPlanFrom(text) {
  return /^yes\b/i.test(String(text || '').trim());
}

function tableEntry(name) {
  return RULEBOOK_TABLE.find(r => r.name === name) || null;
}

function seedRows(bank) {
  const known = new Set((bank.questions || []).map(q => q.id));
  return (bank.rulebooks || []).map((r, i) => {
    const entry = tableEntry(r.rulebook);
    if (!entry) throw new Error(`Rulebook "${r.rulebook}" is not in lib/tprm/rulebooks.RULEBOOK_TABLE.`);
    const parsed = parseQuestionIds(r.question_ids, known);
    if (parsed.unknown.length || parsed.invalid.length) {
      throw new Error(`Rulebook "${r.rulebook}": question ids ${[...parsed.unknown, ...parsed.invalid].join(', ')} are not in the bank.`);
    }
    return {
      key: entry.key,
      position: i + 1,
      name: r.rulebook,
      applies_to: r.applies_to || null,
      status: statusFrom(r.status),
      bank_entry: r,
      question_ids: parsed.ids,
      contract_tags: [...entry.tags],
      exit_plan_required: exitPlanFrom(r.exit_plan),
      data_country: entry.country,
      reference_text: REFERENCES[entry.key] ? REFERENCES[entry.key].reference.slice(0, REFERENCE_TEXT_MAX) : null,
      research_note: researchNote(entry.key, r.source),
    };
  });
}
module.exports = {
  REFERENCE_TEXT_MAX, TAG_FIN, TAG_RBI, TAG_IND, CONTRACT_TAGS, RULEBOOK_TABLE, REFERENCES, NOT_CLIENT_FACING,
  researchNote, parseQuestionIds, statusFrom, exitPlanFrom, tableEntry, seedRows,
};
