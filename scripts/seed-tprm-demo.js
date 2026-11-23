'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const bcrypt = require('bcrypt');
const { answersFor } = require('./tprm-demo-content');

const PREVIEW_DB = 'isms_preview';
const ROOT = path.join(__dirname, '..');
const PUBLIC_BASE = 'http://localhost:3000';

const FIRM = Object.freeze({
  name: 'Northbridge Risk Advisory',
  timezone: 'Asia/Kolkata',
  letterhead: {
    display_name: 'Northbridge Risk Advisory LLP',
    address_lines: '4th Floor, Raheja Centre\nNariman Point\nMumbai 400021',
    contact_line: 'tprm@northbridge-advisory.example  |  +91 22 4000 7100',
    footer_text: 'Northbridge Risk Advisory LLP. Confidential: prepared for the named client only.',
    brand_colour: '#1f4e5f',
  },
});
const PEOPLE = Object.freeze({
  manager: { email: 'meera.kapoor@northbridge-advisory.example', name: 'Meera Kapoor', firmRole: 'manager', password: 'Northbridge-Demo-Manager-2026' },
  senior: { email: 'riya.sharma@northbridge-advisory.example', name: 'Riya Sharma', firmRole: 'senior_consultant', password: 'Northbridge-Demo-Senior-2026' },
  consultant: { email: 'kabir.mehta@northbridge-advisory.example', name: 'Kabir Mehta', firmRole: 'consultant', password: 'Northbridge-Demo-Consultant-2026' },
  client: { email: 'arjun.nair@konkanbank.example', name: 'Arjun Nair', memberRole: 'client_owner', password: 'Konkan-Demo-Client-2026' },
});
const CLIENT = Object.freeze({ name: 'Konkan Coastal Bank', sector: 'Banking' });

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: DATABASE_URL=postgres://.../isms_preview node scripts/seed-tprm-demo.js');
  process.exit(2);
}

function databaseName(url) {
  try { return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')); } catch (_) { return null; }
}

function allowedDatabase(name) {
  if (name === PREVIEW_DB) return true;
  const scratch = process.env.TPRM_DEMO_SCRATCH_DB;
  return !!scratch && scratch === name && /^isms_[a-z0-9_]*scratch$/.test(name);
}

function quietEnvironment() {
  process.env.ISMS_DISABLE_JOBS = '1';
  process.env.EMAIL_DELIVERY_DISABLED = '1';
  for (const name of ['RESEND_API_KEY', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SES_REGION']) process.env[name] = '';
  process.env.EMAIL_DEV_OUTBOX = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tprm-demo-outbox-')), 'outbox.log');
  for (const name of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) process.env[name] = '';
  process.env.AI_PROVIDER = 'none';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error(`seed-tprm-demo: outbound request to ${target.host} refused`);
    return realFetch(input, init);
  };
}

function pdf(title, subtitle, paragraphs) {
  const esc = s => String(s).replace(/[\\()]/g, m => `\\${m}`).replace(/[^\x20-\x7e]/g, '-');
  const wrap = (text, width) => {
    const out = [];
    let line = '';
    for (const word of String(text).split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) { out.push(line); line = word; } else line = (line + ' ' + word).trim();
    }
    if (line) out.push(line);
    return out;
  };
  const lines = [];
  for (const p of paragraphs) {
    if (p.startsWith('# ')) { lines.push({ gap: 8 }, { text: p.slice(2), bold: true }); continue; }
    for (const l of wrap(p, 92)) lines.push({ text: l });
    lines.push({ gap: 6 });
  }
  const pages = [];
  let current = [];
  let y = 790 - wrap(title, 52).length * 20 - (subtitle ? wrap(subtitle, 100).length * 13 : 0) - 24;
  for (const l of lines) {
    const h = l.gap || 14;
    if (y - h < 60) { pages.push(current); current = []; y = 780; }
    current.push({ ...l, y });
    y -= h;
  }
  pages.push(current);
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((items, i) => {
    let s = '';
    if (i === 0) {
      const titleLines = wrap(title, 52);
      titleLines.forEach((t, k) => { s += `BT /F2 16 Tf 56 ${780 - k * 20} Td (${esc(t)}) Tj ET\n`; });
      const subLines = subtitle ? wrap(subtitle, 100) : [];
      let sy = 780 - titleLines.length * 20;
      subLines.forEach(t => { s += `BT /F1 10 Tf 56 ${sy} Td (${esc(t)}) Tj ET\n`; sy -= 13; });
      s += `0.6 w 56 ${sy - 4} m 539 ${sy - 4} l S\n`;
    }
    for (const l of items) if (l.text) s += `BT /${l.bold ? 'F2' : 'F1'} ${l.bold ? 11 : 10} Tf 56 ${l.y} Td (${esc(l.text)}) Tj ET\n`;
    s += `BT /F1 8 Tf 56 36 Td (${esc(`${title.length > 80 ? title.slice(0, 77) + '...' : title}  |  page ${i + 1} of ${pages.length}`)}) Tj ET\n`;
    const content = add(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDay = ymd => { const [y, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

function documentsOf(p) {
  const version = p.policyVersion.replace(/^v/i, '');
  const d = {};
  d.policy = {
    filename: `${p.slug}-information-security-policy-v${version}.pdf`,
    description: `Information Security Policy, version ${version}, approved by the Board`,
    title: `${p.legal}: Information Security Policy`, subtitle: `Version ${version}. Approved by the Board on ${longDay(p.policyReviewed)}. Owner: ${p.ciso.name}, ${p.ciso.title}.`,
    body: [
      '# 1. Purpose',
      `This policy sets out how ${p.legal} protects the confidentiality, integrity and availability of the information it holds for its clients, including ${p.client}.`,
      '# 2. Scope',
      `It applies to all employees, contractors and systems involved in ${p.serviceText}, at ${p.sites.join(' and ')}.`,
      '# 3. Responsibilities',
      `${p.ciso.name}, ${p.ciso.title}, is accountable for information security and reports to ${p.ciso.reports}. Every manager applies this policy in their team.`,
      '# 4. Personnel security',
      'Background checks are completed before joining. Every employee signs a confidentiality agreement and completes security awareness training at joining and every year.',
      '# 5. Access control',
      'Access follows least privilege, is approved by the system owner and is reviewed every quarter for privileged accounts and every six months for others. Multi-factor authentication is required for all remote and administrative access.',
      '# 6. Data classification and handling',
      'Client data is classified as Confidential. It is encrypted at rest and in transit, kept only on approved systems and shared only with named staff.',
      '# 7. Review',
      `This policy is reviewed every year and after any significant change. Last review: ${longDay(p.policyReviewed)}.`,
    ],
  };
  d.iso = {
    filename: `${p.slug}-iso27001-certificate.pdf`,
    description: `ISO/IEC 27001:2022 certificate ${p.cert.number}, with its scope`,
    title: 'Certificate of Registration: ISO/IEC 27001:2022', subtitle: `Issued by ${p.cert.body}. Certificate ${p.cert.number}.`,
    body: [
      `This is to certify that the information security management system of ${p.legal}, ${p.sites[0]}, has been assessed and found to conform to ISO/IEC 27001:2022.`,
      '# Scope', p.cert.scope,
      '# Validity', `First issued ${longDay(p.cert.issued)}. Valid until ${longDay(p.cert.expiry)}, subject to satisfactory surveillance audits. Statement of Applicability version 4.`,
    ],
  };
  d.pentest = {
    filename: `${p.slug}-penetration-test-summary-${p.pentest.date.slice(0, 7)}.pdf`,
    description: `Penetration test summary by ${p.pentest.firm}, ${longDay(p.pentest.date)}`,
    title: 'Penetration Test: Executive Summary', subtitle: `${p.legal}. Tested by ${p.pentest.firm}, ${p.pentest.windowText}.`,
    body: ['# Scope', `External and authenticated testing of the ${p.product} and its supporting infrastructure, including the separation between client accounts.`,
      '# Results', p.pentest.results, '# Remediation', `${p.pentest.closed}.`],
  };
  d.bcp = {
    filename: `${p.slug}-dr-test-report-${p.bcp.lastTest.slice(0, 7)}.pdf`,
    description: `Disaster recovery test report, ${longDay(p.bcp.lastTest)}`,
    title: 'Disaster Recovery Test Report', subtitle: `${p.legal}. Test of ${longDay(p.bcp.lastTest)}. Owner: ${p.bcpOwner}.`,
    body: ['# Scenario', `${p.bcp.testType}: loss of the primary site, with the service run from ${p.bcp.secondary}.`,
      '# Objectives and results', `Committed RTO ${p.bcp.rto} hours and RPO ${p.bcp.rpo} hours. Achieved RTO ${p.bcp.rtoAchieved} and RPO ${p.bcp.rpoAchieved}.`,
      '# Open issues', p.bcp.openIssues],
  };
  d.ir = {
    filename: `${p.slug}-incident-response-plan-summary.pdf`,
    description: 'Incident response plan (summary): severities, roles and client notification',
    title: 'Incident Response Plan (summary)', subtitle: `${p.legal}. Reviewed ${longDay(p.irReviewed)}. Owner: ${p.ciso.name}.`,
    body: ['# Severity levels', 'Severity 1: confirmed breach of client data or loss of the service. Severity 2: suspected breach or major degradation. Severity 3: contained security event.',
      '# Notification', 'Affected clients are told within 6 hours of detecting a severity 1 or 2 incident, by phone to the named contact and then by email, with updates every 24 hours until closure.',
      '# Escalation', `Duty security analyst, then the security manager within 1 hour, then ${p.ciso.name} within 2 hours. Security desk: ${p.securityDesk}.`],
  };
  d.dpa = {
    filename: `${p.slug}-data-processing-addendum-${p.clientSlug}.pdf`,
    description: `Data processing addendum and processing record for ${p.client}`,
    title: 'Data Processing Addendum', subtitle: `Between ${p.client} (data fiduciary) and ${p.legal} (data processor).`,
    body: ['# Processing', `Categories: ${p.personalData} Purpose: ${p.purposes}`,
      '# Instructions', `${p.legal} processes personal data only on ${p.client}'s written instructions and only in India.`,
      '# Breach notification', `Within 24 hours of detection, to ${p.client}'s privacy contact. Contact at ${p.short}: ${p.dpo.name}, ${p.dpo.email}.`,
      '# Erasure', 'Within 30 days of the end of the service or on instruction.'],
  };
  d.subprocessors = {
    filename: `${p.slug}-subprocessor-list.pdf`,
    description: 'Subprocessors, with their locations and what each does',
    title: 'Subprocessor List', subtitle: `${p.legal}. Current as of ${longDay(p.policyReviewed)}.`,
    body: p.subprocessors.split(/(?<=\.)\s+/),
  };
  if (p.soc2) {
    d.soc2 = {
      filename: `${p.slug}-soc2-type2-summary-and-bridge-letter.pdf`,
      description: `SOC 2 Type II summary for ${p.soc2.period}, with the latest bridge letter`,
      title: 'SOC 2 Type II: Summary and Bridge Letter', subtitle: `${p.legal}. Period ${p.soc2.period}.`,
      body: ['# Opinion', 'Unqualified opinion on the Security, Availability and Confidentiality criteria.', '# Exceptions', p.soc2.exceptions, '# Subservice organisations', p.soc2.subservice,
        '# Bridge letter', 'Management confirms no material change to the system or its controls since the end of the period.'],
    };
  }
  return d;
}

function profile(over) {
  return {
    client: CLIENT.name, clientSlug: 'konkan-coastal-bank',
    idp: 'Microsoft Entra ID', kms: 'AWS KMS (ap-south-1)', siem: 'Microsoft Sentinel', edr: 'Microsoft Defender for Endpoint', ids: 'AWS GuardDuty and a managed WAF',
    trainingRate: '98 percent', openAuditFindings: 2, cloudAdmins: 3,
    retention: '7 years for records, or as the client instructs', backupRetention: '35 days',
    otherCerts: 'ISO 22301:2019 (business continuity), valid until March 2028.',
    openAudit: 'Two minor non-conformities from the September 2026 surveillance audit: one overdue access review and one supplier assessment not yet updated.',
    openAuditPlan: 'Both closed by 31 December 2026; the certification body checks them at the next audit.',
    dcTier: 'AWS Mumbai region (Tier III equivalent)', physicalArea: 'the server room', soc2: null,
    ...over,
  };
}

const AWS_MUMBAI = Object.freeze({ provider: 'Amazon Web Services', regions: 'Asia Pacific (Mumbai) ap-south-1; recovery in Asia Pacific (Hyderabad) ap-south-2', models: 'IaaS and managed PaaS', production: 'India, AWS Mumbai (ap-south-1)', dr: 'India, AWS Hyderabad (ap-south-2)' });

const LUMEN = profile({
  slug: 'lumen', short: 'Lumen', legal: 'Lumen Print and Mail Services Private Limited', product: 'secure file transfer service',
  serviceText: 'printing and posting client statements', policyVersion: 'v3.0', policyReviewed: '2026-01-09',
  ciso: { name: 'Neha Kulkarni', title: 'Head of Information Security', reports: 'the Managing Director, not to IT', appointed: '2022-04-01' },
  cert: { number: 'IS 781245', body: 'BSI Group India', issued: '2024-03-18', expiry: '2027-03-17', scope: 'Receipt of client print files over SFTP, printing, enveloping and dispatch of statements and letters, at the Navi Mumbai production centre and the Pune recovery site.' },
  sites: ['the Navi Mumbai production centre (Mahape)', 'the Pune recovery site (Hinjewadi)'],
  internalAudit: '2026-08-21', staffOnService: 14,
  dataDescription: 'statement files with customer names, postal addresses, account numbers and transactions',
  segregation: { type: 'Logical, with a dedicated SFTP account and folder', mechanism: 'Each client has its own SFTP account, its own encrypted folder and its own print job queue; operators see only the jobs assigned to them.', verification: 'Checked in the annual penetration test and by a quarterly review of folder permissions.' },
  accessReview: '2026-09-30', firewallReview: '2026-07-14',
  pentest: { date: '2026-06-12', firm: 'Securelayer7 Technologies', windowText: '1 to 12 Jun 2026', closed: 'Both high findings closed within 21 days and confirmed by a retest', results: 'No critical findings. Two high findings (an outdated TLS setting on the SFTP gateway and a missing account lockout on the print queue console) and five medium findings.' },
  cloud: AWS_MUMBAI,
  personalData: 'Customer names, postal addresses, account numbers and statement transactions.', purposes: 'Printing and posting monthly account statements and letters for the client.',
  dpo: { name: 'Prakash Menon', title: 'Data Protection Officer', email: 'privacy@lumen-printmail.example' },
  backup: { frequency: 'Every night, with 35 days kept', location: 'AWS Hyderabad (ap-south-2), in a separate backup account', lastRestore: '2026-09-18' },
  irReviewed: '2026-05-15', securityDesk: '+91 22 6100 4400, security@lumen-printmail.example',
  tabletop: { date: '2026-08-07', scenario: 'Ransomware on the print servers during the month-end statement run.', lessons: 'Added an offline copy of the print schedule and a call tree for the client\'s operations team.' },
  bcpOwner: 'Sanjay Iyer, Head of Operations',
  bcp: { reviewed: '2026-04-30', rto: 8, rpo: 24, secondary: 'the Pune recovery site (Hinjewadi)', distance: '120 km from Navi Mumbai', lastTest: '2026-05-23', testType: 'Full failover test', rtoAchieved: '6 hours 10 minutes', rpoAchieved: 'under 12 hours', openIssues: 'One: the Pune site has a single enveloping line, so volume runs at 60 percent during a failover. A second line is due in March 2027.' },
  subprocessors: 'Amazon Web Services India Private Limited: SFTP and file storage, Mumbai and Hyderabad. India Post and Blue Dart Express: postal and courier dispatch of sealed envelopes, with no access to files. Shredex Secure Destruction: shredding of spoiled prints at the Mahape site.',
  locations: 'India only: AWS Mumbai (SFTP and files), AWS Hyderabad (backups), Navi Mumbai (printing), Pune (recovery printing).',
  exitReviewed: '2026-06-30', dataVolume: 'About 40 GB a month', dpiaDate: '2026-03-12',
  atRest: 'Files on the SFTP service and in backups are encrypted. Print-ready files on the production print servers are not yet encrypted at rest; disk encryption is planned for the first quarter of 2027.',
  physicalArea: 'the print production floor', dcTier: 'Mahape production centre with two power feeds and diesel generators',
});
LUMEN.overrides = {
  'RET-01': { r: 'yes', f: { period: '180 days for print files, kept for reprints', deletion_trigger: 'Deleted by hand at the end of the period; no certificate is issued' }, ref: 'Lumen retention schedule v1.2', date: '2026-02-20' },
  'PRV-08': { r: 'no', d: 'Print files are kept for 180 days for reprints and deleted by hand. We do not yet issue deletion certificates; we can start if the client asks for it in the contract.' },
  'EXT-04': { r: 'no', d: 'We delete the files at the end of the service but do not issue a written certificate today.' },
};

const MERIDIAN = profile({
  slug: 'meridian', short: 'Meridian', legal: 'Meridian Analytics Private Limited', product: 'hosted dashboard service',
  serviceText: 'hosting branch sales and service dashboards', policyVersion: 'v2.0', policyReviewed: '2026-02-03',
  ciso: { name: 'Farah Khan', title: 'Chief Technology Officer, also responsible for security', reports: 'the CEO', appointed: '2021-07-12' },
  cert: { number: 'IND25.4471', body: 'TUV SUD South Asia', issued: '2025-05-06', expiry: '2028-05-05', scope: 'Design, development, hosting and support of the Meridian analytics platform from the Bengaluru office.' },
  sites: ['the Bengaluru office (Koramangala)'], internalAudit: '2026-04-11', staffOnService: 6, openAuditFindings: 3,
  dataDescription: 'aggregated branch sales and service figures, with manager names and logins',
  segregation: { type: 'Logical, a separate database schema per client', mechanism: 'Each client has its own database schema and storage bucket; the application scopes every query to the signed-in client.', verification: 'Tested by our own QA team before each release; not yet tested by an independent tester.' },
  accessReview: '2026-07-31', firewallReview: '2026-06-05',
  pentest: { date: '2026-01-20', firm: 'our own engineering team (internal test)', windowText: '13 to 20 Jan 2026', closed: 'All findings from the internal test closed', results: 'Internal test only: three medium findings, no high or critical ones.' },
  cloud: AWS_MUMBAI,
  personalData: 'Names, work email addresses and login records of the client\'s branch managers. No customer data.', purposes: 'Giving the client\'s managers access to their dashboards.',
  dpo: { name: 'Farah Khan', title: 'Chief Technology Officer and privacy contact', email: 'privacy@meridian-analytics.example' },
  backup: { frequency: 'Every night, 14 days kept', location: 'AWS Hyderabad (ap-south-2)', lastRestore: '2026-08-02' },
  irReviewed: '2026-03-02', securityDesk: '+91 80 4600 2200, security@meridian-analytics.example',
  tabletop: { date: '2025-09-15', scenario: 'Leaked administrator credentials.', lessons: 'Moved administrators to hardware keys.' },
  bcpOwner: 'Farah Khan, Chief Technology Officer',
  bcp: { reviewed: '2026-02-20', rto: 12, rpo: 24, secondary: 'AWS Hyderabad (ap-south-2)', distance: 'about 700 km from Mumbai', lastTest: '2026-03-14', testType: 'Restore test of the database and dashboards', rtoAchieved: '9 hours', rpoAchieved: '24 hours', openIssues: 'None open.' },
  subprocessors: 'Amazon Web Services India Private Limited: hosting, Mumbai and Hyderabad. Freshworks Technologies: support ticketing, holding the names and emails of users who raise tickets.',
  locations: 'India only: AWS Mumbai (production), AWS Hyderabad (backups).',
  exitReviewed: '2026-05-10', dataVolume: 'About 15 GB', dpiaDate: '2026-02-01', atRest: 'Databases, storage buckets and backups are encrypted with AWS KMS keys.',
  otherCerts: 'None other than ISO 27001.', openAudit: 'Three minor non-conformities from the May 2026 audit, on supplier reviews and log retention.', openAuditPlan: 'To be closed by 31 January 2027.',
});
MERIDIAN.overrides = {
  'CLM-03': { f: { enforcement: 'Each client has its own database schema and storage bucket; the application scopes every query to the signed-in client. Separate KMS keys per client.', validation: 'Tested by our own QA team before each release.', independent_test: 'No. The first independent test is booked for February 2027' } },
  'VUL-02': { f: { sla_per_severity: 'Critical 7 days, high 30 days, medium 90 days, low at the next planned change.', vapt_closure_days: 'Critical and high within 30 days of the report', current_adherence: '78 percent within target this year; two high findings from January closed after 45 days', exception_route: 'The CTO approves any finding left open past its target, with a new date.' }, ref: 'Vulnerability management procedure v1.1', date: '2026-01-30' },
};

const PINNACLE = profile({
  slug: 'pinnacle', short: 'Pinnacle', legal: 'Pinnacle Service Desk Software Private Limited', product: 'hosted IT service desk',
  serviceText: 'the hosted IT service desk, asset register and staff self-service portal', policyVersion: 'v4.2', policyReviewed: '2026-03-12',
  ciso: { name: 'Vikram Shah', title: 'Chief Information Security Officer', reports: 'the CEO', appointed: '2023-01-16' },
  cert: { number: 'IN-ISMS-20931', body: 'Bureau Veritas India', issued: '2025-08-01', expiry: '2028-07-31', scope: 'Development, hosting and support of the Pinnacle service desk platform from the Ahmedabad and Mumbai offices.' },
  sites: ['the Ahmedabad office (SG Highway)', 'the Mumbai support office (Andheri East)'], internalAudit: '2026-06-18', staffOnService: 9,
  dataDescription: 'staff names, emails, ticket contents and the asset inventory',
  segregation: { type: 'Logical, a separate tenant per client', mechanism: 'Each client is a separate tenant with its own database and encryption key.', verification: 'Tested by an independent firm every year.' },
  accessReview: '2026-09-15', firewallReview: '2026-08-20',
  pentest: { date: '2026-05-08', firm: 'Payatu Security Consulting', windowText: '27 Apr to 8 May 2026', closed: 'The high finding was closed within 14 days', results: 'One high finding (stored cross-site scripting in ticket attachments) and four medium findings.' },
  cloud: AWS_MUMBAI,
  personalData: 'Names, work emails and phone numbers of the client\'s staff, and the text of their support tickets.', purposes: 'Running the client\'s IT service desk.',
  dpo: { name: 'Aditi Joshi', title: 'Data Protection Officer', email: 'privacy@pinnacle-desk.example' },
  backup: { frequency: 'Every 4 hours, 30 days kept', location: 'AWS Hyderabad (ap-south-2)', lastRestore: '2026-09-10' },
  irReviewed: '2026-04-01', securityDesk: '+91 79 4000 8800, soc@pinnacle-desk.example',
  tabletop: { date: '2026-06-20', scenario: 'A support engineer\'s laptop stolen with an active session.', lessons: 'Shortened session lifetimes for support staff to 8 hours.' },
  bcpOwner: 'Rahul Dave, Head of Operations',
  bcp: { reviewed: '2026-05-02', rto: 4, rpo: 4, secondary: 'AWS Hyderabad (ap-south-2)', distance: 'about 700 km from Mumbai', lastTest: '2026-05-20', testType: 'Full regional failover test', rtoAchieved: '2 hours 40 minutes', rpoAchieved: 'under 4 hours', openIssues: 'None open.' },
  subprocessors: 'Amazon Web Services India Private Limited: hosting, Mumbai and Hyderabad. Twilio: SMS notifications, phone numbers only. SendGrid: email notifications.',
  locations: 'India, except email and SMS notifications, which pass through Twilio and SendGrid in the United States.',
  exitReviewed: '2026-07-01', dataVolume: 'About 25 GB', dpiaDate: '2026-04-15', atRest: 'Databases, attachments and backups are encrypted with a separate KMS key per tenant.',
});
PINNACLE.overrides = {
  'IAM-03': { r: 'no', d: 'MFA is enforced for administrators and support leads. Rollout to all service desk agents finishes on 31 January 2027.' },
};

const QUILL = profile({
  slug: 'quill', short: 'Quill', legal: 'Quill eSign Technologies Private Limited', product: 'electronic signature service',
  serviceText: 'the electronic signature service for loan and account-opening documents', policyVersion: 'v5.1', policyReviewed: '2026-04-02',
  ciso: { name: 'Sunil Rao', title: 'Chief Information Security Officer', reports: 'the CEO and the Board risk committee', appointed: '2020-10-05' },
  cert: { number: 'ISMS 640118', body: 'BSI Group India', issued: '2023-11-20', expiry: '2026-11-19', scope: 'Development, hosting and operation of the Quill electronic signature platform from Hyderabad.' },
  sites: ['the Hyderabad office (HITEC City)'], internalAudit: '2026-07-29', staffOnService: 7,
  dataDescription: 'customer names, email addresses, mobile numbers and the documents they sign',
  segregation: { type: 'Logical, a separate account and storage key per client', mechanism: 'Each client has its own account, document store and encryption key; signing links are single-use.', verification: 'Tested every year by an independent firm and covered by the SOC 2 report.' },
  accessReview: '2026-09-25', firewallReview: '2026-09-02',
  pentest: { date: '2026-08-18', firm: 'NotSoSecure', windowText: '5 to 18 Aug 2026', closed: 'No high findings; all three medium findings closed', results: 'No critical or high findings; three medium findings.' },
  cloud: AWS_MUMBAI,
  personalData: 'Customer names, email addresses, mobile numbers, signatures and the loan and account-opening documents they sign.', purposes: 'Collecting customer signatures on documents the client sends for signing.',
  dpo: { name: 'Lakshmi Narayanan', title: 'Data Protection Officer', email: 'dpo@quill-esign.example' },
  backup: { frequency: 'Continuous, with point-in-time restore for 35 days', location: 'AWS Hyderabad (ap-south-2)', lastRestore: '2026-10-08' },
  irReviewed: '2026-06-10', securityDesk: '+91 40 4800 1500, security@quill-esign.example',
  tabletop: { date: '2026-09-12', scenario: 'A client\'s signing links leaked on social media.', lessons: 'Added a way to expire all open links of a client at once.' },
  bcpOwner: 'Deepa Reddy, Head of Platform Operations',
  bcp: { reviewed: '2026-06-30', rto: 2, rpo: 1, secondary: 'AWS Hyderabad (ap-south-2)', distance: 'about 700 km from Mumbai', lastTest: '2026-09-27', testType: 'Full regional failover test', rtoAchieved: '1 hour 25 minutes', rpoAchieved: 'under 15 minutes', openIssues: 'None open.' },
  subprocessors: 'Amazon Web Services India Private Limited: hosting, Mumbai and Hyderabad. Gupshup Technology India: SMS one-time passwords, mobile numbers only. eMudhra Limited: Aadhaar eSign certificates when the client chooses Aadhaar signing.',
  locations: 'India only: AWS Mumbai (production), AWS Hyderabad (recovery and backups).',
  exitReviewed: '2026-08-31', dataVolume: 'About 300 GB of signed documents', dpiaDate: '2026-05-20', atRest: 'Documents, databases and backups are encrypted with a separate KMS key per client.',
  soc2: { period: '1 Apr 2025 to 31 Mar 2026', exceptions: 'One exception: two leavers kept access for 6 days in October 2025; the leaver process was automated afterwards.', subservice: 'Amazon Web Services (carved out); we review its SOC 2 report every year.' },
  otherCerts: 'ISO 27701:2019 (privacy) and ISO 22301:2019 (business continuity), both valid until November 2027.',
});
QUILL.overrides = {
  'ASR-01': { r: 'yes', f: { certificate_number: 'ISMS 640118', certification_body: 'BSI Group India', issue_date: '2023-11-20', expiry_date: '2026-11-19',
    scope: 'Development, hosting and operation of the Quill electronic signature platform from Hyderabad. The renewal audit took place on 17 and 18 November 2026 with no non-conformities; the renewed certificate is expected within days.' }, doc: 'iso' },
};

const DEMO = [
  { key: 'added', details: { name: 'Northwind Courier Services', legal_name: 'Northwind Courier Services Private Limited', status: 'proposed', category: 'Logistics', country: 'India', website: 'https://northwind-courier.example', primary_contact_name: 'Meera Pillai', primary_contact_email: 'meera.pillai@northwind-courier.example' },
    service: { description: 'Same-day courier of signed account-opening forms between the Ratnagiri and Mumbai branches.', data_access: 'Sealed envelopes with signed customer forms; no system access.', hosting_countries: '', contract_start: '2027-01-01', notice_period_days: '30', annual_spend: '180000' } },
  { key: 'proposed', scope: 'high', details: { name: 'Brightline Payroll Solutions', legal_name: 'Brightline Payroll Solutions LLP', status: 'proposed', category: 'HR and payroll', country: 'India', website: 'https://brightline-payroll.example', primary_contact_name: 'Rohan Desai', primary_contact_email: 'rohan.desai@brightline-payroll.example' },
    service: { description: 'Monthly payroll, payslips and statutory filings (PF, ESI, TDS) for about 640 employees.', data_access: 'Employee names, bank accounts, PAN, salary and attendance data, uploaded every month.', hosting_countries: 'India', contract_start: '2027-04-01', contract_end: '2030-03-31', notice_period_days: '90', annual_spend: '1450000' } },
  { key: 'linked', scope: 'high', recipient: { recipient_name: 'Anita Rao', recipient_email: 'anita.rao@cloudvault.example' }, dueDate: '2027-01-15',
    details: { name: 'CloudVault Backup', legal_name: 'CloudVault Data Protection Private Limited', status: 'in_use', category: 'Cloud backup', country: 'India', website: 'https://cloudvault.example', primary_contact_name: 'Anita Rao', primary_contact_email: 'anita.rao@cloudvault.example' },
    service: { description: 'Managed off-site backup of the branch file servers and the Microsoft 365 tenant, with 90-day retention.', data_access: 'Encrypted copies of all file shares and mailboxes, including customer correspondence.', hosting_countries: 'India', contract_start: '2024-04-01', contract_end: '2027-03-31', notice_period_days: '60', annual_spend: '420000' } },
  { key: 'partial', profile: PINNACLE, scope: 'medium', recipient: { recipient_name: 'Vikram Shah', recipient_email: 'vikram.shah@pinnacle-desk.example' }, dueDate: '2027-01-20',
    details: { name: 'Pinnacle Service Desk', legal_name: PINNACLE.legal, status: 'in_use', category: 'IT service management', country: 'India', website: 'https://pinnacle-desk.example', primary_contact_name: 'Vikram Shah', primary_contact_email: 'vikram.shah@pinnacle-desk.example' },
    service: { description: 'Hosted IT service desk: ticketing, the IT asset register and the staff self-service portal.', data_access: 'Staff names, emails and ticket contents; read-only access to the asset inventory.', hosting_countries: 'India', contract_start: '2025-07-01', contract_end: '2027-06-30', notice_period_days: '60', annual_spend: '310000' } },
  { key: 'review', profile: MERIDIAN, scope: 'medium', recipient: { recipient_name: 'Farah Khan', recipient_email: 'farah.khan@meridian-analytics.example' }, dueDate: '2026-12-15',
    details: { name: 'Meridian Analytics', legal_name: MERIDIAN.legal, status: 'in_use', category: 'Business intelligence', country: 'India', website: 'https://meridian-analytics.example', primary_contact_name: 'Farah Khan', primary_contact_email: 'farah.khan@meridian-analytics.example' },
    service: { description: 'Hosted dashboards for branch sales and service figures, fed by a nightly extract from the core banking system.', data_access: 'Aggregated sales and service figures; no customer identifiers. Named logins for 35 branch managers.', hosting_countries: 'India', contract_start: '2025-01-01', contract_end: '2026-12-31', notice_period_days: '45', annual_spend: '275000' } },
  { key: 'issued', profile: LUMEN, scope: 'high', recipient: { recipient_name: 'Sanjay Iyer', recipient_email: 'sanjay.iyer@lumen-printmail.example' }, dueDate: '2026-12-10',
    details: { name: 'Lumen Print & Mail', legal_name: LUMEN.legal, status: 'proposed', category: 'Print and mail', country: 'India', website: 'https://lumen-printmail.example', primary_contact_name: 'Sanjay Iyer', primary_contact_email: 'sanjay.iyer@lumen-printmail.example' },
    service: { description: 'Monthly printing and posting of customer account statements from files sent over SFTP.', data_access: 'Customer names, postal addresses and statement contents (personal data).', hosting_countries: 'India', contract_start: '2027-01-01', contract_end: '2028-12-31', notice_period_days: '90', annual_spend: '540000' } },
  { key: 'approved', profile: QUILL, scope: 'high', recipient: { recipient_name: 'Deepa Reddy', recipient_email: 'deepa.reddy@quill-esign.example' }, dueDate: '2026-11-15',
    details: { name: 'Quill eSign', legal_name: QUILL.legal, status: 'proposed', category: 'Electronic signature', country: 'India', website: 'https://quill-esign.example', primary_contact_name: 'Deepa Reddy', primary_contact_email: 'deepa.reddy@quill-esign.example' },
    service: { description: 'Electronic signing of loan agreements and account-opening forms by customers, with OTP and Aadhaar eSign.', data_access: 'Customer names, mobile numbers, emails and the documents they sign (personal data).', hosting_countries: 'India', contract_start: '2026-10-01', contract_end: '2029-09-30', notice_period_days: '90', annual_spend: '860000' } },
];

const SCOPE = {
  medium: { data_handled: 'internal', service_stops: 'slows', system_access: 'user', regulated: 'no', replaceability: 'with_effort' },
  high: { data_handled: 'personal', service_stops: 'slows', system_access: 'user', regulated: 'no', replaceability: 'with_effort' },
};
const HOSTED = { delivery_model: 'vendor_hosted', payments_records: 'no', sites_data: 'no', supplies_software: 'no' };

function httpRequest(port, method, urlPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: urlPath, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), location: res.headers.location || null }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function formBody(fields) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach(item => form.append(k, item));
    else form.append(k, v == null ? '' : String(v));
  }
  return form.toString();
}

function session(port) {
  let cookies = '';
  let csrf = null;
  async function send(method, urlPath, fields) {
    const headers = {};
    if (cookies) headers.cookie = cookies;
    if (csrf) headers['x-csrf-token'] = csrf;
    let body = null;
    if (fields) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formBody(fields._csrf || !csrf ? fields : { ...fields, _csrf: csrf });
    }
    const res = await httpRequest(port, method, urlPath, { body, headers });
    const set = res.headers['set-cookie'];
    if (set) {
      const fresh = (Array.isArray(set) ? set : [set]).map(c => c.split(';')[0]);
      const kept = cookies ? cookies.split('; ').filter(c => !fresh.some(n => n.startsWith(c.split('=')[0] + '='))) : [];
      cookies = [...kept, ...fresh].join('; ');
    }
    const m = res.text.match(/name="csrf-token" content="([a-f0-9]+)"/);
    if (m) csrf = m[1];
    return res;
  }
  async function postMultipart(urlPath, fields) {
    const form = multipart(Object.entries({ _csrf: csrf || '', ...fields }));
    const res = await httpRequest(port, 'POST', urlPath, { body: form.body, headers: { ...form.headers, cookie: cookies } });
    return res;
  }
  return { get: p => send('GET', p, null), post: (p, fields) => send('POST', p, fields || {}), postMultipart };
}

async function signIn(port, who) {
  const s = session(port);
  const page = await s.get('/login');
  const token = (page.text.match(/name="_csrf"\s+value="([a-f0-9]+)"/) || [])[1];
  if (!token) throw new Error('The login page has no CSRF field.');
  const res = await s.post('/login', { email: who.email, password: who.password, _csrf: token });
  if (res.status !== 302) throw new Error(`${who.email} could not sign in (${res.status}).`);
  let landing = await s.get('/dashboard');
  for (let i = 0; landing.location && i < 5; i++) landing = await s.get(landing.location);
  return s;
}

const toastOf = res => { const m = String(res.location || '').match(/[?&]toast=([^&#]*)/); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; };
const isErrorToast = res => /[?&]toastKind=error/.test(String(res.location || ''));
function expectRedirect(res, what) {
  if (![302, 303].includes(res.status) || isErrorToast(res)) {
    const detail = toastOf(res) || (res.text.match(/class="text-lg text-secondary"[^>]*>([^<]{3,400})</) || [])[1] || [...res.text.matchAll(/<li[^>]*>([^<]{3,300})<\/li>/g)].map(m => m[1]).slice(0, 4).join(' | ') || res.text.slice(0, 300);
    throw new Error(`${what} failed (${res.status}): ${String(detail).replace(/\s+/g, ' ').trim()}`);
  }
  return res;
}

function multipart(fields, files = []) {
  const boundary = '----tprmdemo' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const chunks = [];
  for (const [k, v] of fields) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.type || 'application/pdf'}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function upsertPeople(db) {
  let firm = await db.prepare('SELECT id FROM firms WHERE name = ?').get(FIRM.name);
  if (!firm) firm = { id: Number((await db.prepare('INSERT INTO firms (name, timezone) VALUES (?, ?)').run(FIRM.name, FIRM.timezone)).lastInsertRowid) };
  const firmId = Number(firm.id);
  const ids = {};
  for (const [key, who] of Object.entries(PEOPLE)) {
    const type = who.firmRole ? 'firm' : 'client';
    const existing = await db.prepare('SELECT id, firm_id, user_type FROM users WHERE lower(email) = lower(?)').get(who.email);
    if (existing) {
      if (existing.user_type !== type || (type === 'firm' && Number(existing.firm_id) !== firmId)) throw new Error(`${who.email} exists outside the demo firm; stopping.`);
      ids[key] = Number(existing.id);
      continue;
    }
    ids[key] = Number((await db.prepare('INSERT INTO users (email, password_hash, name, user_type, firm_id, firm_role, active) VALUES (?, ?, ?, ?, ?, ?, 1)')
      .run(who.email, bcrypt.hashSync(who.password, 10), who.name, type, type === 'firm' ? firmId : null, who.firmRole || null)).lastInsertRowid);
  }
  let ws = await db.prepare('SELECT id FROM workspaces WHERE firm_id = ? AND client_name = ?').get(firmId, CLIENT.name);
  if (!ws) {
    ws = { id: Number((await db.prepare(`INSERT INTO workspaces (firm_id, client_name, sector, timezone, frameworks, engagement_outcome, lead_consultant_id)
      VALUES (?, ?, ?, ?, '["iso27001"]', 'certification_support', ?)`).run(firmId, CLIENT.name, CLIENT.sector, FIRM.timezone, ids.consultant)).lastInsertRowid) };
  }
  const wsId = Number(ws.id);
  for (const [key, role] of [['manager', 'manager'], ['senior', 'senior_consultant'], ['consultant', 'consultant'], ['client', 'client_owner']]) {
    const m = await db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, ids[key]);
    if (!m) await db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, ids[key], role);
  }
  return { firmId, wsId, ids };
}

async function seed({ app, db, publicBase = PUBLIC_BASE, log = console.log }) {
  const { firmId, wsId, ids } = await upsertPeople(db);
  const BANK = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tprm-question-bank.json'), 'utf8'));
  const BANK_BY_ID = new Map(BANK.questions.map(q => [q.id, q]));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const port = server.address().port;
  const results = [];
  let vendorRoute = null;
  try { vendorRoute = require('../routes/tprm-vendor'); } catch (_) {}
  const resetLimits = () => {
    if (!vendorRoute) return;
    for (const l of [vendorRoute.limiter, vendorRoute.postLimiter, vendorRoute.conditionsLimiter, vendorRoute.conditionsPostLimiter]) if (l && l.reset) l.reset();
  };
  try {
    const manager = await signIn(port, PEOPLE.manager);
    const consultant = await signIn(port, PEOPLE.consultant);
    const senior = await signIn(port, PEOPLE.senior);

    const settings = await db.prepare('SELECT enabled FROM tp_client_settings WHERE workspace_id = ?').get(wsId);
    if (!settings || !settings.enabled) expectRedirect(await manager.post(`/tprm/clients/${wsId}/enable`, {}), 'Switching third-party risk on');
    const lhPage = await manager.get('/tprm/settings/letterhead');
    if (!lhPage.text.includes(`value="${FIRM.letterhead.display_name}"`)) {
      const lhVersion = (lhPage.text.match(/name="row_version" value="(\d+)"/) || [])[1] || '0';
      expectRedirect(await manager.postMultipart('/tprm/settings/letterhead', { ...FIRM.letterhead, row_version: lhVersion }), 'Saving the letterhead');
    }

    const tpBase = tp => `/tprm/clients/${wsId}/third-parties/${tp}`;
    const aBase = (tp, a) => `${tpBase(tp)}/assessments/${a}`;
    const qBase = (tp, a) => `${aBase(tp, a)}/questionnaire`;
    const assessment = async a => db.prepare('SELECT * FROM tp_assessments WHERE id = ?').get(a);
    const questionnaire = async a => db.prepare('SELECT * FROM tp_questionnaires WHERE assessment_id = ?').get(a);
    const idsOf = q => q.sections.flatMap(s => s.ids);
    const expectStatus = async (a, want, what) => {
      const row = await assessment(a);
      if (row.status !== want) throw new Error(`${what}: the assessment is "${row.status}", expected "${want}".`);
    };
    const expectQuestionnaire = async (a, want, what) => {
      const q = await questionnaire(a);
      if (!q || q.status !== want) throw new Error(`${what}: the questionnaire is "${q ? q.status : 'missing'}", expected "${want}".`);
    };

    async function addThirdParty(demo) {
      const res = expectRedirect(await consultant.post(`/tprm/clients/${wsId}/third-parties`, demo.details), `Adding ${demo.details.name}`);
      const tp = Number((String(res.location).match(/third-parties\/(\d+)/) || [])[1]);
      if (!tp) throw new Error(`Adding ${demo.details.name}: no third-party id in ${res.location}`);
      const has = await db.prepare('SELECT 1 FROM tp_services WHERE workspace_id = ? AND third_party_id = ?').get(wsId, tp);
      if (!has) expectRedirect(await consultant.post(`${tpBase(tp)}/services`, demo.service), `Adding the service of ${demo.details.name}`);
      return tp;
    }
    async function startAssessment(tp, demo) {
      const res = expectRedirect(await consultant.post(`${tpBase(tp)}/assessments`, {}), `Starting the assessment of ${demo.details.name}`);
      return Number((String(res.location).match(/assessments\/(\d+)/) || [])[1]);
    }
    async function proposeTier(tp, a, demo) {
      const services = (await db.prepare('SELECT id FROM tp_services WHERE workspace_id = ? AND third_party_id = ?').all(wsId, tp)).map(r => String(r.id));
      const body = { services, intent: 'propose', row_version: String((await assessment(a)).row_version) };
      for (const [qid, value] of Object.entries({ ...SCOPE[demo.scope], ...HOSTED })) body[`answers[${qid}]`] = value;
      const res = await consultant.post(`${aBase(tp, a)}/scope`, body);
      if (res.status !== 302) throw new Error(`Proposing the tier of ${demo.details.name} failed (${res.status})`);
      await expectStatus(a, 'tier_proposed', `Proposing the tier of ${demo.details.name}`);
    }
    async function confirmTier(tp, a, demo) {
      expectRedirect(await senior.post(`${aBase(tp, a)}/confirm`, { row_version: String((await assessment(a)).row_version) }), `Confirming the tier of ${demo.details.name}`);
      await expectStatus(a, 'tier_confirmed', `Confirming the tier of ${demo.details.name}`);
    }
    async function setDetails(tp, a, demo) {
      expectRedirect(await consultant.post(`${aBase(tp, a)}/details`, {
        due_date: demo.dueDate || '', client_decision_owner_id: String(ids.client), row_version: String((await assessment(a)).row_version) }),
      `Saving the details of ${demo.details.name}`);
    }
    async function createLink(tp, a, demo) {
      const q = await questionnaire(a);
      const res = await consultant.post(`${qBase(tp, a)}/links`, { ...demo.recipient, row_version: String(q.row_version) });
      const url = (res.text.match(/value="([^"]*\/vendor\/q\/[A-Za-z0-9_-]+)"/) || [])[1] || null;
      if (res.status !== 200 || !url) throw new Error(`Issuing the link of ${demo.details.name} failed (${res.status}): ${toastOf(res) || res.text.slice(0, 200)}`);
      return url.split('/vendor/q/')[1];
    }
    async function linked(demo) {
      const tp = await addThirdParty(demo);
      const a = await startAssessment(tp, demo);
      await proposeTier(tp, a, demo);
      await confirmTier(tp, a, demo);
      await setDetails(tp, a, demo);
      expectRedirect(await consultant.post(qBase(tp, a), {}), `Preparing the questionnaire of ${demo.details.name}`);
      const token = await createLink(tp, a, demo);
      return { tp, a, q: await questionnaire(a), token };
    }

    const aftOf = text => (String(text).match(/name="_aft" value="([^"]+)"/) || [])[1];
    async function vpost(token, suffix, fields, files = []) {
      resetLimits();
      const page = await httpRequest(port, 'GET', `/vendor/q/${token}?view=documents`);
      const aft = aftOf(page.text);
      if (!aft) throw new Error(`The vendor page has no anti-forgery field (${page.status}).`);
      resetLimits();
      const form = multipart([['_aft', aft], ...fields], files);
      return await httpRequest(port, 'POST', `/vendor/q/${token}${suffix}`, { body: form.body, headers: form.headers });
    }
    async function shelve(token, a, docs) {
      const list = Object.values(docs);
      for (let i = 0; i < list.length; i += 5) {
        const batch = list.slice(i, i + 5);
        const res = await vpost(token, '/documents', batch.map((d, j) => [`desc_${j + 1}`, d.description]),
          batch.map((d, j) => ({ field: `doc_file_${j + 1}`, filename: d.filename, content: pdf(d.title, d.subtitle, d.body) })));
        if (res.status !== 303) throw new Error(`Adding documents failed (${res.status}): ${res.text.slice(0, 300)}`);
      }
      const rows = await db.prepare('SELECT id, original_name FROM tp_evidence WHERE assessment_id = ?').all(a);
      return Object.fromEntries(Object.entries(docs).map(([k, d]) => [k, (rows.find(r => r.original_name === d.filename) || {}).id]));
    }
    function answerFields(answers, docIds) {
      const out = [];
      const lacking = [];
      for (const [id, v] of Object.entries(answers)) {
        const q = BANK_BY_ID.get(id) || {};
        if (v.r) out.push([`r[${id}]`, v.r]);
        if (v.t !== undefined) out.push([`t[${id}]`, v.t]);
        const docId = v.doc && docIds ? docIds[v.doc] : null;
        const on = q.evidence_on || 'yes';
        const needs = !!q.evidence_mandatory && v.r !== 'na' && (on === 'answer' ? !v.r : v.r === on);
        if (needs && !docId && !v.ref) lacking.push(id);
        out.push([`d[${id}]`, v.d || ''], [`ref[${id}]`, docId ? '' : (v.ref || '')], [`date[${id}]`, docId ? '' : (v.date || '')]);
        if (docId) out.push([`pick[${id}]`, String(docId)]);
        if (v.f) for (const [key, value] of Object.entries(v.f)) out.push([`f[${id}][${key}]`, value]);
        if (v.y !== undefined) out.push([`y[${id}]`, v.y]);
      }
      if (lacking.length) throw new Error(`No document or reference for ${lacking.join(', ')}`);
      return out;
    }
    async function answer(token, answers, docIds) {
      const qids = Object.keys(answers);
      for (let i = 0; i < qids.length; i += 40) {
        const part = Object.fromEntries(qids.slice(i, i + 40).map(id => [id, answers[id]]));
        const res = await vpost(token, '/save', [...answerFields(part, docIds), ['intent', 'save']]);
        if (res.status !== 303) {
          const msg = [...res.text.matchAll(/<li[^>]*>([^<]{3,300})<\/li>/g)].map(m => m[1]).slice(0, 6).join(' | ') || res.text.slice(0, 300);
          throw new Error(`The vendor's save failed (${res.status}): ${String(msg).replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    async function submit(token, demo) {
      const res = await vpost(token, '/submit', [['confirm_submit', '1']]);
      if (res.status !== 200 || !/data-vendor-submitted|Submitted on/.test(res.text)) {
        const problems = [...res.text.matchAll(/<li[^>]*>([\s\S]{3,200}?)<\/li>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 8).join(' | ');
        throw new Error(`${demo.details.name}: the submission failed (${res.status}): ${problems || res.text.slice(0, 300)}`);
      }
    }
    function written(demo, q) {
      const { answers, missing } = answersFor(demo.profile, idsOf(q));
      if (missing.length) throw new Error(`${demo.details.name}: no demo answer written for ${missing.join(', ')}`);
      return answers;
    }

    async function acceptPlain(tp, a) {
      const page = await consultant.get(`${aBase(tp, a)}?step=review&answers=unexpected`);
      const m = page.text.match(/data-tprm-accept-plain-form="all"[\s\S]*?name="ids" value="([^"]*)"/);
      if (!m || !m[1]) return 0;
      expectRedirect(await consultant.post(`${qBase(tp, a)}/accept-plain`, { ids: m[1] }), 'Accepting the plain answers');
      return m[1].split(',').length;
    }
    async function conclude(tp, a, questionId, conclusion, comment = '') {
      const row = await db.prepare('SELECT id, row_version FROM tp_answers WHERE assessment_id = ? AND question_id = ?').get(a, questionId);
      if (!row) throw new Error(`No answer to ${questionId}.`);
      expectRedirect(await consultant.post(`${qBase(tp, a)}/answers/${row.id}/review`, { conclusion, comment, row_version: String(row.row_version) }), `Concluding on ${questionId}`);
    }
    async function concludeRest(tp, a, judged) {
      const rows = await db.prepare("SELECT question_id FROM tp_answers WHERE assessment_id = ? AND review_conclusion = 'not_reviewed' ORDER BY question_id").all(a);
      for (const r of rows) {
        const j = judged[r.question_id];
        await conclude(tp, a, r.question_id, j ? j[0] : 'satisfactory', j ? j[1] : '');
      }
    }
    async function raiseFinding(tp, a, questionId, f) {
      const bank = BANK_BY_ID.get(questionId) || {};
      expectRedirect(await consultant.post(`${aBase(tp, a)}/findings`, { control_ref: bank.iso27001 ? `A.${bank.iso27001}` : '', status: 'open', ...f }), `Raising "${f.title}"`);
      return Number((await db.prepare('SELECT id FROM tp_findings WHERE assessment_id = ? AND title = ?').get(a, f.title)).id);
    }
    async function recommend(tp, a, body, comment) {
      expectRedirect(await consultant.post(`${aBase(tp, a)}/recommendations`, { row_version: String((await assessment(a)).row_version) }), 'Starting the recommendation');
      const rec = await db.prepare('SELECT id, row_version FROM tp_recommendations WHERE assessment_id = ? ORDER BY version DESC LIMIT 1').get(a);
      expectRedirect(await consultant.post(`${aBase(tp, a)}/recommendations/${rec.id}`, { ...body, intent: 'submit', row_version: String(rec.row_version) }), 'Submitting the recommendation');
      const inReview = await db.prepare('SELECT row_version FROM tp_recommendations WHERE id = ?').get(rec.id);
      expectRedirect(await senior.post(`${aBase(tp, a)}/recommendations/${rec.id}/issue`, { row_version: String(inReview.row_version), comment }), 'Issuing the recommendation');
      await expectStatus(a, 'recommendation_issued', 'Issuing the recommendation');
      return Number(rec.id);
    }

    for (const demo of DEMO) {
      resetLimits();
      const existing = await db.prepare('SELECT id FROM tp_third_parties WHERE workspace_id = ? AND lower(name) = lower(?)').get(wsId, demo.details.name);
      if (existing) { results.push({ name: demo.details.name, stage: 'already present, skipped', tp: Number(existing.id) }); continue; }
      log(`Seeding ${demo.details.name} ...`);
      const row = { name: demo.details.name, links: [] };
      results.push(row);

      if (demo.key === 'added') { row.tp = await addThirdParty(demo); row.stage = 'On the register, no assessment yet'; continue; }
      if (demo.key === 'proposed') {
        row.tp = await addThirdParty(demo);
        row.assessment = await startAssessment(row.tp, demo);
        await proposeTier(row.tp, row.assessment, demo);
        row.stage = 'Tier proposed, waiting for a second person to confirm';
        continue;
      }

      const { tp, a, q, token } = await linked(demo);
      Object.assign(row, { tp, assessment: a, questions: q.vendor_question_count });
      if (demo.key === 'linked') { row.stage = 'Questionnaire sent, nothing answered yet'; row.links.push({ label: 'Vendor link', token }); continue; }

      const docs = documentsOf(demo.profile);
      const answers = written(demo, q);

      if (demo.key === 'partial') {
        const docIds = await shelve(token, a, { policy: docs.policy, iso: docs.iso });
        const firstIds = q.sections.slice(0, Math.max(1, Math.ceil(q.sections.length * 0.4))).flatMap(s => s.ids);
        const part = {};
        for (const id of firstIds) {
          const v = { ...answers[id] };
          if (v.doc && !docIds[v.doc]) { delete v.doc; if (!v.ref) { v.ref = 'Will upload with the remaining answers'; v.date = '2026-11-20'; } }
          part[id] = v;
        }
        await answer(token, part, docIds);
        await expectQuestionnaire(a, 'in_progress', demo.details.name);
        row.stage = `Partly answered by the vendor (${Object.keys(part).length} of ${q.vendor_question_count})`;
        row.links.push({ label: 'Vendor link (partly answered)', token });
        continue;
      }

      const docIds = await shelve(token, a, docs);
      await answer(token, answers, docIds);
      await submit(token, demo);
      await expectQuestionnaire(a, 'submitted', demo.details.name);

      if (demo.key === 'review') {
        await acceptPlain(tp, a);
        await conclude(tp, a, 'CLM-03', 'unsatisfactory', 'The separation between clients has only been tested by Meridian\'s own QA team.');
        await conclude(tp, a, 'VUL-02', 'partially_satisfactory', 'Targets are sound but only 78 percent were met this year.');
        await raiseFinding(tp, a, 'CLM-03', { severity: 'medium', title: 'No independent test of the separation between clients',
          description: 'Meridian has never had the hosted dashboards tested by an independent firm; its own QA team tests each release. The first independent test is booked for February 2027.',
          impact: 'Branch managers sign in to the dashboards from the internet. Without an independent test, weaknesses in the separation between clients or in sign-in could go unnoticed and expose the bank\'s sales figures.' });
        expectRedirect(await consultant.post(`${qBase(tp, a)}/clarifications`, { question_id: 'INC-01',
          body: 'Your incident response plan was last reviewed in March 2026. When did you last run an incident response exercise or tabletop, what was the scenario, and when is the next one planned?' }), 'Asking a clarification');
        await expectQuestionnaire(a, 'under_review', demo.details.name);
        row.links.push({ label: 'Vendor link for the clarification', token: await createLink(tp, a, demo) });
        row.stage = 'Submitted and under review: a finding and an open clarification';
        continue;
      }

      if (demo.key === 'issued') {
        await acceptPlain(tp, a);
        await concludeRest(tp, a, {
          'CRY-02': ['partially_satisfactory', 'Print-ready files on the production print servers are not encrypted at rest.'],
          'RET-01': ['unsatisfactory', '180-day retention for reprints and no deletion certificate.'],
          'PRV-08': ['unsatisfactory', 'No certificate of erasure today.'],
          'EXT-04': ['partially_satisfactory', 'Deletes on exit but gives no written certificate.'],
        });
        const f1 = await raiseFinding(tp, a, 'CRY-02', { severity: 'medium', title: 'Print files not encrypted at rest',
          description: 'Statement files are decrypted onto the production print servers at the Mahape centre, which have no disk encryption.',
          impact: `${CLIENT.name}'s customer statements carry names, addresses and account details. A stolen or recycled print server disk would expose them, which is a reportable personal data breach for the bank.` });
        const f2 = await raiseFinding(tp, a, 'RET-01', { severity: 'low', title: 'No evidence of data deletion',
          description: 'Print files are kept for 180 days for reprints and deleted by hand; Lumen does not confirm deletion to the client.',
          impact: 'Statement files kept for 180 days with no deletion record leave the bank unable to show that customer data is deleted when no longer needed.' });
        expectRedirect(await consultant.post(`${qBase(tp, a)}/close`, { row_version: String((await questionnaire(a)).row_version) }), 'Closing the review');
        row.recommendation = await recommend(tp, a, {
          outcome: 'approve_with_conditions', residual_rating: 'medium', valid_until: '2027-12-31',
          rationale: 'Lumen\'s controls are adequate for printing and posting statements: ISO 27001 certified, encrypted transfer over SFTP, background-checked production staff and a tested continuity plan. Two gaps remain: print-ready files are not encrypted at rest and deletion is not confirmed. Both are manageable with the conditions below before go-live.',
          'conditions[0][description]': 'Enable disk encryption on the production print servers and send evidence (configuration screenshot or report).',
          'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2027-02-28', 'conditions[0][finding_id]': String(f1),
          'conditions[1][description]': 'Agree in the contract a 30-day retention for print files and a monthly deletion certificate.',
          'conditions[1][owner]': 'client', 'conditions[1][due_date]': '2027-01-31', 'conditions[1][finding_id]': String(f2),
        }, 'Agreed. Both conditions to be met before go-live.');
        row.stage = 'Recommendation issued (onboard with conditions), waiting for the client\'s decision';
        continue;
      }

      if (demo.key === 'approved') {
        await acceptPlain(tp, a);
        await concludeRest(tp, a, { 'ASR-01': ['partially_satisfactory', 'The ISO 27001 certificate expired on 19 Nov 2026; the renewal audit is done but the new certificate is not yet issued.'] });
        const f1 = await raiseFinding(tp, a, 'ASR-01', { severity: 'low', title: 'ISO 27001 certificate expired',
          description: 'Quill\'s ISO 27001 certificate expired on 19 November 2026. The renewal audit took place on 17 and 18 November with no non-conformities, but the renewed certificate had not been issued when Quill answered.',
          impact: 'Until it is renewed, the bank relies on the SOC 2 report alone for independent assurance of Quill\'s controls.' });
        expectRedirect(await consultant.post(`${qBase(tp, a)}/close`, { row_version: String((await questionnaire(a)).row_version) }), 'Closing the review');
        const rid = await recommend(tp, a, {
          outcome: 'approve_with_conditions', residual_rating: 'low', valid_until: '2027-11-30',
          rationale: 'Quill has strong controls for an e-signature service: a SOC 2 Type II report with one exception, since fixed, separate encryption keys for each client, data kept in India and recovery tested in September. The only gap is the lapsed ISO 27001 certificate, which is being renewed.',
          'conditions[0][description]': 'Send the renewed ISO 27001 certificate.', 'conditions[0][owner]': 'vendor', 'conditions[0][due_date]': '2027-01-31', 'conditions[0][finding_id]': String(f1),
          'conditions[1][description]': 'Add Quill to the bank\'s list of material outsourcing arrangements reported to the Board.', 'conditions[1][owner]': 'client', 'conditions[1][due_date]': '2027-03-31',
        }, 'Agreed.');
        const client = await signIn(port, PEOPLE.client);
        const recPage = `/workspaces/${wsId}/client-portal/third-party-risk/recommendations/${rid}`;
        await client.get(recPage);
        expectRedirect(await client.post(`${recPage}/decision`, { outcome: 'approve_with_conditions' }), 'Recording the client decision');
        await consultant.get(aBase(tp, a));
        const linkRes = await consultant.post(`${aBase(tp, a)}/conditions-link`, { recipient_name: 'Deepa Reddy', recipient_email: 'deepa.reddy@quill-esign.example', expires_in_days: '30' });
        const ctoken = (linkRes.text.match(/\/vendor\/c\/([A-Za-z0-9_-]+)/) || [])[1];
        if (!ctoken) throw new Error(`Creating the conditions link failed (${linkRes.status}).`);
        const cond = await db.prepare("SELECT id FROM tp_conditions WHERE recommendation_id = ? AND owner = 'vendor'").get(rid);
        resetLimits();
        const cpage = await httpRequest(port, 'GET', `/vendor/c/${ctoken}`);
        const renewed = pdf('Certificate of Registration: ISO/IEC 27001:2022', `Issued by ${QUILL.cert.body}. Certificate ${QUILL.cert.number}, renewed.`,
          [`This is to certify that the information security management system of ${QUILL.legal}, Hyderabad, has been assessed and found to conform to ISO/IEC 27001:2022.`, '# Scope', QUILL.cert.scope, '# Validity', 'Renewed 21 November 2026, after the audit of 17 and 18 November 2026. Valid until 20 November 2029.']);
        resetLimits();
        const form = multipart([['_aft', aftOf(cpage.text)], ['note', 'Renewed certificate attached; the audit closed with no non-conformities.']],
          [{ field: 'files', filename: 'quill-iso27001-certificate-renewed.pdf', content: renewed }]);
        const proof = await httpRequest(port, 'POST', `/vendor/c/${ctoken}/conditions/${cond.id}/proof`, { body: form.body, headers: form.headers });
        if (proof.status !== 303) throw new Error(`Sending the proof failed (${proof.status}): ${proof.text.slice(0, 300)}`);
        const c = await db.prepare('SELECT row_version FROM tp_conditions WHERE id = ?').get(cond.id);
        expectRedirect(await consultant.post(`${aBase(tp, a)}/conditions/${cond.id}/verify`, { row_version: String(c.row_version), note: 'Renewed certificate checked against the BSI register.' }), 'Verifying the condition');
        row.recommendation = rid;
        row.stage = 'Approved with conditions: the vendor\'s condition verified, the client\'s still open';
        continue;
      }
    }
  } finally {
    await new Promise(resolve => {
      server.close(() => resolve());
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      setTimeout(resolve, 500);
    });
  }

  log('');
  log(`TPRM demo: firm "${FIRM.name}" (id ${firmId}), client "${CLIENT.name}" (workspace ${wsId}).`);
  results.forEach((r, i) => {
    log(`${i + 1}. ${r.name}: ${r.stage}`);
    if (r.assessment) log(`   ${publicBase}/tprm/clients/${wsId}/third-parties/${r.tp}/assessments/${r.assessment}`);
    for (const l of r.links || []) log(`   ${l.label}: ${publicBase}/vendor/q/${l.token}`);
  });
  const broken = await require('../lib/tprm/events').verifyChains(db, wsId);
  log(broken.length ? `Event chains: ${broken.length} BROKEN (${JSON.stringify(broken)})` : 'Event chains: every chain of this client verifies.');
  log('Sign in as:');
  for (const who of Object.values(PEOPLE)) log(`   ${who.email} / ${who.password}  (${who.name})`);
  return { firmId, wsId, results };
}

async function main() {
  if (process.argv.length > 2) usage('This script takes no arguments: the demo has its own firm and client.');
  if (!process.env.DATABASE_URL) usage('DATABASE_URL is not set: point it at the isms_preview database.');
  const name = databaseName(process.env.DATABASE_URL);
  if (!allowedDatabase(name)) usage(`Refusing to run: the database in DATABASE_URL is "${name}", and this script only runs against "${PREVIEW_DB}" (or the scratch copy named in TPRM_DEMO_SCRATCH_DB).`);
  if (process.env.NODE_ENV === 'production') usage('Refusing to run with NODE_ENV=production.');
  quietEnvironment();
  process.chdir(ROOT);
  const { app, db, ready } = require('../server.js');
  await ready;
  if (databaseName(process.env.DATABASE_URL) !== name) throw new Error('DATABASE_URL changed while the app loaded; stopping.');
  const current = await db.prepare('SELECT current_database() AS name').get();
  if (!current || current.name !== name || !allowedDatabase(current.name)) throw new Error(`Connected to "${current && current.name}"; stopping.`);
  try { await seed({ app, db }); } finally { try { await db.close(); } catch (_) {} }
}

module.exports = { seed, quietEnvironment, DEMO, PEOPLE, FIRM, CLIENT, pdf, documentsOf };

if (require.main === module) {
  main().then(() => process.exit(0), error => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}
