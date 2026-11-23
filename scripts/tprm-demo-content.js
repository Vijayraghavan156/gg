'use strict';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = ymd => { const [y, m, d] = String(ymd).split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

const A = {
  'GOV-01': p => ({ f: { review_frequency: 'Every year, and after any significant change', approver: `${p.ciso.name}, ${p.ciso.title}; approved by the Board`, current_version: p.policyVersion, last_review_date: p.policyReviewed }, doc: 'policy' }),
  'GOV-02': p => ({ r: 'yes', f: { name: p.ciso.name, title: p.ciso.title, reporting_line: p.ciso.reports, date_appointed: p.ciso.appointed }, doc: 'policy' }),
  'GOV-03': p => ({ r: 'yes', f: { assessment_frequency: 'Every year, and before any major change to the service', client_risk_treatment: `Risks to ${p.client} data are tagged in the register, owned by the service head and reviewed monthly by the security committee. Treatment plans above medium are approved by ${p.ciso.name}.` }, doc: 'policy' }),
  'GOV-04': p => ({ r: 'yes', f: { scope_statement: p.cert.scope, delivery_locations: p.sites.join('; ') }, doc: 'iso' }),
  'GOV-06': p => ({ r: 'yes', y: `Kept by our compliance lead and reviewed every quarter. It lists the DPDP Act 2023, CERT-In directions, the RBI outsourcing directions that apply to ${p.client}, and our contract obligations.` }),
  'GOV-08': p => ({ r: 'yes', f: { audit_frequency: 'Every year', last_audit_date: p.internalAudit, open_findings: String(p.openAuditFindings) }, ref: `Internal audit report ${p.internalAudit.slice(0, 4)}`, date: p.internalAudit }),
  'AIS-01': () => ({ r: 'no', d: 'No AI or machine learning is used to provide this service.' }),

  'ORG-01': p => ({ r: 'yes', f: { checks_performed: 'Identity, address, education, previous employment and criminal record checks through an accredited agency, before the first day.', reverification_cycle: 'Every 3 years, and on moving to a privileged role' }, doc: 'policy' }),
  'ORG-02': p => ({ r: 'yes', f: { contractor_coverage: `All ${p.staffOnService} staff and contractors on the ${p.client} service`, survives_termination: 'Yes, for 5 years after leaving' }, doc: 'policy' }),
  'ORG-03': p => ({ f: { delivery_frequency: 'At joining and every year, plus quarterly phishing simulations', completion_tracking: `Tracked in our learning system; managers get a weekly list of anyone overdue, and access is suspended after 30 days overdue.`, completion_rate: `${p.trainingRate} in the last cycle` }, doc: 'policy' }),
  'ORG-04': () => ({ r: 'yes', y: 'Administrators and developers complete secure administration and OWASP Top 10 modules every year; support staff complete a data handling module.' }),
  'ORG-05': () => ({ r: 'yes', y: 'Set out in the HR policy and the employee handbook, from a written warning to dismissal, applied by HR with the security team.' , ref: 'HR policy, section 9 (disciplinary process)', date: '2026-02-01' }),
  'ORG-06': () => ({ r: 'yes', f: { sla_hours: '4', revocation_evidence: 'HR closes the leaver record; single sign-on and all application accounts are disabled automatically, and the access log is kept with the leaver ticket.' }, ref: 'Joiner, mover and leaver procedure v2.3', date: '2026-04-10' }),

  'AST-01': p => ({ r: 'yes', f: { inventory_scope: `Servers, network devices, laptops, cloud resources and SaaS applications used for the ${p.client} service.`, owner_assignment: 'Every asset has a named owner in the CMDB', review_frequency: 'Reconciled every quarter' } }),
  'AST-02': p => ({ r: 'yes', f: { client_data_mapping: `${p.client} data is classified as Confidential: ${p.dataDescription}.`, handling_rules: 'Confidential data is encrypted at rest and in transit, kept only on approved systems, never emailed outside the company and shared only with named staff on the service.' }, doc: 'policy' }),
  'AST-03': () => ({ r: 'yes', y: 'Every employee accepts it at joining and every year; it covers client data, email, removable media and personal devices.', ref: 'Acceptable use policy v3.0', date: '2026-01-20' }),
  'AST-04': () => ({ r: 'yes', f: { control_type: 'USB storage blocked by the endpoint agent', approved_exceptions: 'None at present. An exception needs the security head\'s approval and uses an encrypted company drive for a fixed period.' }, ref: 'Endpoint security standard v1.4', date: '2026-03-15' }),
  'AST-05': p => ({ f: { segregation_type: p.segregation.type, segregation_mechanism: p.segregation.mechanism, verification: p.segregation.verification }, doc: 'pentest' }),
  'AST-06': p => ({ r: 'yes', ref: `${p.short} service inventory for ${p.client} (CMDB export)`, date: '2026-09-30' }),

  'IAM-01': () => ({ r: 'yes', y: 'Access is role-based and granted by the system owner on request; nobody has standing access to client data beyond their role.', ref: 'Access control policy v2.1', date: '2026-02-12' }),
  'IAM-02': () => ({ r: 'yes' }),
  'IAM-03': p => ({ r: 'yes', y: `MFA through ${p.idp} for all staff, and hardware keys for administrators. Remote access is only through the zero-trust gateway.` }),
  'IAM-05': p => ({ f: { review_frequency: 'Privileged access every quarter; all other access every six months', last_review_date: p.accessReview, revocation_evidence: 'Each review is a ticket with the reviewer\'s sign-off and the list of accounts removed.', revocation_sla: 'Removed within 2 working days of the review' }, ref: `Access review ${p.accessReview}`, date: p.accessReview }),
  'IAM-06': p => ({ f: { length: '14 characters minimum', complexity: 'Passphrases allowed; checked against breached-password lists', lockout: 'Locked for 15 minutes after 5 failed attempts', rotation: 'No forced rotation; reset on any sign of compromise', credential_storage: `Passwords held only by ${p.idp}; service credentials in a secrets vault, never in code.` }, ref: 'Password and authentication standard v1.2', date: '2026-02-12' }),
  'IAM-07': p => ({ r: 'yes', y: `${p.staffOnService} named people. ${p.client} receives the list at the start and whenever it changes.` }),
  'IAM-08': p => ({ r: 'yes', f: { trigger_mechanism: `The HR system sends joiner, mover and leaver events to ${p.idp}, which creates, changes or disables accounts the same day.`, reconciliation_controls: 'A monthly report compares HR records with active accounts; any mismatch is fixed and recorded.' }, ref: 'Joiner, mover and leaver procedure v2.3', date: '2026-04-10' }),
  'IAM-11': p => ({ f: { countries_locations_teams: `India only: the ${p.sites[0]} operations team. No offshore or third-country access.`, access_route: 'Company laptops through the zero-trust gateway with MFA.', outside_access_approval: 'Not permitted', outside_access_restriction: 'Sign-ins from outside India are blocked by conditional access rules.', outside_access_logging: 'All sign-ins are logged in the SIEM and blocked attempts raise an alert.' } , ref: 'Remote access standard v1.1', date: '2026-03-20' }),

  'CRY-01': () => ({ r: 'yes', f: { protocol_versions: 'TLS 1.2 and 1.3; SFTP for file transfers', cipher_suites: 'ECDHE with AES-GCM suites only; CBC and RC4 suites disabled.', minimum_tls: 'TLS 1.2', legacy_disabled: 'Yes, SSL and TLS 1.0 and 1.1 are disabled' }, ref: 'Cryptography standard v1.1', date: '2026-06-30' }),
  'CRY-02': p => ({ r: 'yes', f: { algorithm: 'AES', key_length: '256-bit', coverage: p.atRest }, ref: 'Cryptography standard v1.1', date: '2026-06-30' }),
  'CRY-03': p => ({ r: 'yes', f: { rotation_periods: 'Data keys every year; certificates every year', key_material_access: `Two named administrators; keys held in ${p.kms}` }, ref: 'Key management procedure v1.0', date: '2026-06-30' }),
  'CRY-05': () => ({ r: 'yes', f: { monitoring_tool: 'Certificate manager with expiry alerts', lead_time: 'Alert 30 days before expiry; most renew automatically' } }),

  'NET-01': p => ({ r: 'yes', f: { segmentation_model: `Separate production, management and corporate networks${p.cloud ? ` (separate ${p.cloud.provider} accounts and VPCs)` : ''}, with default-deny rules between them.`, validation: 'Rules reviewed every six months and tested in the annual penetration test.' }, doc: 'pentest' }),
  'NET-02': p => ({ r: 'yes', f: { review_frequency: 'Every six months', last_review_date: p.firewallReview } }),
  'NET-03': () => ({ r: 'yes', y: 'All administration goes through the zero-trust gateway; no admin interface is reachable from the internet.' }),
  'NET-04': p => ({ r: 'yes', f: { technology: p.ids, alert_handling: `Alerts go to the SIEM and the 24x7 monitoring desk, which triages within 15 minutes and escalates to the on-call engineer.` } }),
  'NET-06': () => ({ r: 'yes', f: { benchmark: 'CIS Benchmarks level 1', compliance_measurement: 'Configuration scans every week; compliance is above 95 percent and exceptions are approved and recorded.' }, ref: 'Hardening standard v2.0', date: '2026-05-05' }),

  'APP-01': () => ({ r: 'yes', f: { gates: 'Threat review at design, peer review and static analysis on every merge, dependency scanning in the pipeline, and a security sign-off before each major release.', exception_approver: 'Head of Information Security' }, ref: 'Secure development procedure v1.6', date: '2026-04-22' }),
  'APP-02': () => ({ r: 'yes', f: { standard: 'OWASP ASVS level 2 and OWASP Top 10', training_frequency: 'Every year, at joining for new developers' } , ref: 'Secure coding standard v2.0', date: '2026-04-22' }),
  'APP-03': () => ({ r: 'yes', f: { tooling: 'GitHub pull requests with Semgrep and Dependabot', blocking_policy: 'A merge needs one approving reviewer and no open high or critical findings from the scanners.' } }),
  'APP-04': p => ({ r: 'yes', f: { test_frequency: 'Every year and after major releases', last_test_date: p.pentest.date, tester: p.pentest.firm, high_findings_closed: p.pentest.closed }, doc: 'pentest' }),
  'APP-05': () => ({ r: 'yes', y: 'Separate accounts and networks for development, test and production; developers have no production access.' }),
  'APP-06': () => ({ r: 'yes', y: 'Live client data is never used outside production; test environments use generated data.' , ref: 'Secure development procedure v1.6, section 5', date: '2026-04-22' }),
  'APP-07': () => ({ r: 'yes', f: { emergency_change_handling: 'Emergency changes are approved by the duty manager by phone, made by two people, and logged in the change ticket.', retrospective_approval: 'Reviewed by the change board within 2 working days.' }, ref: 'Change management procedure v2.0', date: '2026-03-01' }),

  'CLD-01': p => ({ f: { providers: p.cloud.provider, regions: p.cloud.regions, service_models: p.cloud.models } }),
  'CLD-02': p => ({ r: 'yes', y: `A responsibility matrix for the ${p.client} service lists, for each control, whether ${p.cloud.provider}, ${p.short} or ${p.client} owns it.`, ref: 'Shared responsibility matrix v1.0', date: '2026-07-15' }),
  'CLD-04': p => ({ f: { isolation_enforcement: p.segregation.mechanism, isolation_validation: p.segregation.verification } }),
  'CLD-05': p => ({ r: 'yes', f: { administrator_count: String(p.cloudAdmins), root_accounts_locked: 'Yes, root accounts have hardware MFA and are used only for break-glass' } }),
  'CLD-06': p => ({ r: 'yes', y: `Organisation policies allow resources only in ${p.cloud.regions}; anything created elsewhere is blocked.` }),

  'VUL-01': () => ({ r: 'yes', f: { scan_frequency: 'Every week, authenticated', coverage: 'All servers, containers and internet-facing addresses used for the service.', tooling: 'Tenable Nessus' }, ref: 'Vulnerability scan summary, September 2026', date: '2026-09-30' }),
  'VUL-02': () => ({ f: { sla_per_severity: 'Critical 7 days, high 30 days, medium 90 days, low at the next planned change.', vapt_closure_days: 'Critical and high within 30 days of the report', current_adherence: '96 percent within target this year', exception_route: 'A finding that cannot be fixed in time needs a written risk acceptance from the security head, with a compensating control and a new date.' }, ref: 'Vulnerability management procedure v1.3', date: '2026-02-18' }),
  'VUL-03': () => ({ r: 'yes', f: { cadence_per_severity: 'Critical within 7 days, high within 30 days, others in the monthly patch window.', compensating_controls: 'Where a patch must wait, the service is isolated or the vulnerable feature turned off until it is applied.' } , ref: 'Patch management procedure v1.5', date: '2026-02-18' }),
  'VUL-04': p => ({ f: { test_frequency: 'Every year', last_test_date: p.pentest.date, testing_firm: p.pentest.firm, findings_closed: p.pentest.closed }, doc: 'pentest' }),

  'LOG-01': () => ({ r: 'yes', y: 'Sign-ins, administrator actions, file transfers, configuration changes and security events are logged on every system supporting the service.' , ref: 'Logging and monitoring standard v1.2', date: '2026-03-10' }),
  'LOG-02': p => ({ r: 'yes', f: { platform: p.siem, sources: 'Identity provider, servers, firewalls, the file transfer service and the cloud audit logs.' } }),
  'LOG-03': () => ({ f: { retention_period: '12 months online, 3 years archived', legal_period: '180 days under the CERT-In directions', location: 'India', protection: 'Logs are written to write-once storage; only the security team can read them and nobody can delete them before the retention ends.', failure_monitoring: 'An alert is raised if a source stops sending logs for more than an hour.' } }),
  'LOG-07': () => ({ r: 'yes', f: { delivery: 'On request, and alerts as they happen', format: 'CSV or JSON', lead_time: 'Within 2 working days', integration: 'Syslog or API feed to the client SIEM on request' } , ref: 'Log and alert sharing procedure v1.0', date: '2026-06-01' }),

  'END-01': p => ({ r: 'yes', f: { product: p.edr, coverage: '100' } }),
  'END-02': () => ({ r: 'yes', f: { admin_roles: 'Only the IT support team has local administrator rights, through a time-limited elevation tool.', justification: 'Needed to install approved software and fix faults; each elevation is logged.' } }),
  'END-03': () => ({ r: 'no', d: 'Only company-managed laptops can reach client data. Personal and mobile devices are blocked by conditional access.' }),

  'PRV-01': () => ({ r: 'yes' }),
  'PRV-02': p => ({ f: { categories: p.personalData, purposes: p.purposes, lawful_basis: `${p.client}'s written instructions under the contract`, purpose_limitation: 'Used only for the contracted service' }, doc: 'dpa' }),
  'PRV-03': p => ({ r: 'yes', f: { name: p.dpo.name, title: p.dpo.title, contact_address: p.dpo.email } , doc: 'dpa' }),
  'PRV-04': p => ({ r: 'yes', f: { review_cycle: 'Every year', service_recorded: `Yes, the ${p.client} service is a separate entry` }, doc: 'dpa' }),
  'PRV-05': () => ({ r: 'yes', y: 'Encryption, role-based access, logging, staff training and the controls certified under ISO 27001.' , ref: 'Data protection policy v2.0', date: '2026-01-15' }),
  'PRV-06': () => ({ r: 'yes', f: { turnaround: 'Within 5 working days of the client\'s request', channel: 'The privacy mailbox, tracked as a ticket' } , doc: 'dpa' }),
  'PRV-07': p => ({ f: { window_hours: '24', escalation_contact: `${p.dpo.name}, ${p.dpo.email}` }, doc: 'dpa' }),
  'PRV-08': p => ({ r: 'yes', f: { timeframe: 'Within 30 days of the end of the purpose or the client\'s instruction', backup_deletion: `Backups expire within ${p.backupRetention}; they are not restored except for recovery.`, backup_records: 'The deletion date of each backup set is recorded and included in the certificate.', legal_exception: 'None, unless a court or regulator orders us to keep data.' }, doc: 'dpa' }),
  'PRV-09': p => ({ r: 'no', d: `All ${p.client} personal data is stored and processed in India.` }),

  'RET-01': p => ({ r: 'yes', f: { period: p.retention, deletion_trigger: 'Automatic deletion job at the end of the period' }, ref: 'Retention schedule v1.4', date: '2026-02-20' }),
  'RET-02': () => ({ r: 'yes', f: { standard: 'NIST SP 800-88 (purge or destroy)', third_party: 'Certified e-waste partner, with a destruction certificate per batch' }, ref: 'Media disposal procedure v1.1', date: '2026-02-20' }),
  'RET-03': p => ({ f: { frequency: p.backup.frequency, location: p.backup.location, encryption: 'Yes, AES-256', restore_frequency: 'Every quarter', last_restore: p.backup.lastRestore }, doc: 'bcp' }),
  'RET-04': () => ({ r: 'yes', f: { format: 'CSV and the original files, over SFTP', timeframe_days: '30' } }),

  'INC-01': p => ({ r: 'yes', f: { last_review: p.irReviewed, owner: `${p.ciso.name}, ${p.ciso.title}` }, doc: 'ir' }),
  'INC-02': () => ({ f: { hours: '6', channel: 'Phone to the client\'s named contact, then email' }, doc: 'ir' }),
  'INC-03': p => ({ r: 'yes', f: { contact_details: `Security desk, 24x7: ${p.securityDesk}`, escalation_levels: `1. Duty security analyst; 2. Security manager within 1 hour; 3. ${p.ciso.name} within 2 hours.` }, doc: 'ir' }),
  'INC-04': p => ({ r: 'yes', f: { frequency: 'Twice a year', last_date: p.tabletop.date, scenario: p.tabletop.scenario, lessons: p.tabletop.lessons } }),
  'INC-05': () => ({ r: 'yes', y: 'A root cause report within 10 working days, with the corrective actions and their dates.' , doc: 'ir' }),
  'INC-08': () => ({ r: 'no' }),

  'BCP-01': p => ({ r: 'yes', f: { owner: p.bcpOwner, last_review: p.bcp.reviewed }, doc: 'bcp' }),
  'BCP-02': p => ({ f: { rto_hours: String(p.bcp.rto), rpo_hours: String(p.bcp.rpo), contractual: 'Yes, in the service schedule' } }),
  'BCP-03': p => ({ r: 'yes', f: { location: p.bcp.secondary, distance: p.bcp.distance, power: 'Two grid feeds and diesel generators', network: 'Two carriers on separate routes', staffing: 'Trained staff at both sites; either can run the service alone' } , doc: 'bcp' }),
  'BCP-04': p => ({ f: { frequency: 'Twice a year', last_test: p.bcp.lastTest, test_type: p.bcp.testType, rto_met: 'Yes', rpo_met: 'Yes' }, doc: 'bcp' }),
  'BCP-05': () => ({ r: 'yes', f: { fourth_party: 'Yes, the hosting and network providers are included' } }),
  'BCP-08': p => ({ f: { rto_achieved: p.bcp.rtoAchieved, rpo_achieved: p.bcp.rpoAchieved, open_issues: p.bcp.openIssues }, doc: 'bcp' }),
  'BCP-09': p => ({ r: 'yes', f: { immutability: 'Object lock on the backup copies for 30 days', isolation: 'Backups are held in a separate account that production administrators cannot reach.', last_clean_restore: day(p.backup.lastRestore) } }),
  'BCP-11': () => ({ r: 'yes', f: { roles: 'Operations lead, two operators and the on-call engineer for each shift.', backups: 'Each role has a named deputy trained on the same tasks.', arrangement: 'Essential staff can work from the secondary site; transport and meals are arranged during disruptions.' } }),

  'FTP-01': p => ({ t: p.subprocessors, doc: 'subprocessors' }),
  'FTP-02': () => ({ r: 'yes', ref: 'Supplier security procedure v1.2', date: '2026-03-30' }),
  'FTP-03': () => ({ r: 'yes' }),
  'FTP-04': () => ({ t: 'Every year: we review their certificates and audit reports, their incident history and any change to where they process data. Critical subprocessors also answer our security questionnaire.' }),
  'FTP-05': () => ({ r: 'yes' }),

  'PHY-01': p => ({ r: 'yes', y: `Badge access at ${p.sites[0]}, with a separate locked area for ${p.physicalArea}.`, ref: 'Physical security standard v1.0', date: '2026-01-25' }),
  'PHY-02': () => ({ f: { controls_in_place: 'CCTV at all entrances and in the production area, a visitor register with ID checks and escorts, and badge access logs.', cctv_retention: '90 days', visitor_record_retention: '1 year', access_log_retention: '1 year' }, ref: 'Physical security standard v1.0', date: '2026-01-25' }),
  'PHY-03': p => ({ r: 'yes', f: { resilience_rating: p.dcTier, certification: 'ISO 27001 and SOC 2 (the data centre operator)' } , ref: 'Facility resilience summary 2026', date: '2026-04-30' }),

  'REG-01': () => ({ r: 'yes', y: 'Yes, subject to the usual review by our legal team.' }),
  'REG-02': () => ({ r: 'yes', f: { notice_period: '10 working days', scope_restrictions: 'Other clients\' data stays out of scope; on-site visits are escorted.' } }),
  'REG-04': () => ({ r: 'yes', y: 'Within 5 working days, from systems in India.' }),
  'REG-06': () => ({ r: 'yes', f: { trigger: 'Any regulatory action, sanction, insolvency event or litigation that could affect the service.', timeframe: 'Within 5 working days' } }),
  'REG-07': () => ({ r: 'yes' }),
  'REG-10': p => ({ f: { locations: p.locations, leaves_country: 'No', transfers: 'None' } , doc: 'subprocessors' }),

  'ASR-01': p => ({ r: 'yes', f: { certificate_number: p.cert.number, certification_body: p.cert.body, issue_date: p.cert.issued, expiry_date: p.cert.expiry, scope: p.cert.scope }, doc: 'iso' }),
  'ASR-02': () => ({ r: 'yes', y: 'Yes, the current Statement of Applicability, version 4, shared under NDA.', doc: 'iso' }),
  'ASR-03': p => (p.soc2
    ? { r: 'yes', f: { period_covered: p.soc2.period, trust_services_criteria: 'Security, Availability and Confidentiality', exceptions: p.soc2.exceptions, subservice_organisations: p.soc2.subservice, user_entity_controls: 'Client user access reviews and secure transfer of files to us.' }, doc: 'soc2' }
    : { r: 'no', d: 'We hold ISO 27001 instead; a SOC 2 Type II report is not planned.' }),
  'ASR-04': p => ({ t: p.otherCerts, doc: 'iso' }),
  'ASR-05': p => (p.soc2 ? { r: 'yes', y: 'A bridge letter is issued every quarter until the next report.', doc: 'soc2' } : { r: 'na', d: 'We have no SOC 2 report, so no bridge letter applies.' }),
  'ASR-06': p => ({ f: { open_items: p.openAudit, closure_plan: p.openAuditPlan } }),

  'EXT-01': p => ({ r: 'yes', f: { plan_owner: p.bcpOwner, last_review_date: p.exitReviewed }, ref: 'Exit and transition plan v1.0', date: p.exitReviewed }),
  'EXT-02': () => ({ r: 'yes', f: { export_formats: 'CSV, JSON and the original files', non_exportable_data: 'None.' } , ref: 'Data export guide v1.2', date: '2026-05-10' }),
  'EXT-03': () => ({ f: { assistance_months: '3', support: 'A named transition manager, data exports, and parallel running for one cycle if needed.', commercial_terms: 'Included for the first month; after that at the rates in the contract.' } }),
  'EXT-04': () => ({ r: 'yes', f: { timeframe: 'Within 30 days of the end of transition', backups_covered: 'Yes, backups are included in the certificate' } }),
  'EXT-06': p => ({ f: { data_volume: p.dataVolume, transfer_capacity: '1 Gbps over SFTP', lead_time: '5 working days', egress_cost: 'None charged to the client.', non_extractable_data: 'None.' } }),
  'EXT-08': p => ({ r: 'yes', f: { assessment_date: p.exitReviewed, assessment_cadence: 'Every year', migration_changes: 'Data and files are in standard formats; another provider could take over with the export and 4 to 6 weeks of set-up.' } }),

  'CLM-01': p => ({ r: 'yes', ref: `Shared responsibility matrix for ${p.client}, v1.0`, date: '2026-07-15' }),
  'CLM-02': p => ({ f: { production: p.cloud.production, dr_backup: p.cloud.dr, logs: p.cloud.production, support: `${p.sites[0]} (no offshore support)`, management_plane: `${p.cloud.provider} console, ${p.cloud.production}` } , ref: 'Data location register v1.0', date: '2026-07-15' }),
  'CLM-03': p => ({ f: { enforcement: `${p.segregation.mechanism} Separate keys per client in ${p.kms}.`, validation: p.segregation.verification, independent_test: `Yes, ${p.pentest.firm}, ${day(p.pentest.date)}` } }),
  'CLM-04': p => ({ r: 'yes', f: { privileged_accounts: String(p.cloudAdmins), root_security: 'Root accounts have hardware MFA, no access keys, and an alert on any use; break-glass use is reviewed by the security head.' } }),
  'CLM-05': () => ({ r: 'yes', f: { tooling: 'AWS Security Hub with CIS benchmark checks', compliance_position: '97 percent compliant against the approved baseline.', open_high: 'None open.' } }),
  'CLM-06': p => ({ r: 'yes', y: `Keys are held in ${p.kms} in India and rotated every year; two administrators can manage them. Customer-managed keys are available on request.` }),
  'CLM-07': p => ({ r: 'yes', y: `Two availability zones in ${p.cloud.production} with failover tested twice a year; the recovery copy stays in India.` , doc: 'bcp' }),
  'CLM-08': p => ({ r: 'yes', y: `${p.cloud.provider}'s SOC 2 report is reviewed every year, including its exceptions and the complementary controls we operate.` }),
  'CLM-09': () => ({ f: { provenance: 'Base images come only from the provider\'s official images or our own hardened images.', signing: 'Images are signed in the build pipeline and only signed images can be deployed.', hardening: 'CIS-hardened, scanned before release and rebuilt with each patch cycle.', rebuild_cadence: 'Every month' } }),
  'CLM-10': () => ({ r: 'yes', y: 'Yes, the responsibility matrix gives each task a single owner.' , ref: 'Shared responsibility matrix v1.0', date: '2026-07-15' }),
  'CLM-11': p => ({ r: 'yes', f: { assessment_date: p.exitReviewed, cadence: 'Every year', migration: 'Standard services only (virtual machines, object storage, managed PostgreSQL), which other providers offer.' } }),
  'CLM-12': () => ({ r: 'yes', f: { route: 'Provider health and security notices go to our security desk, which raises an incident and informs the client\'s contact where the service is affected.', timeframe: 'Within 6 hours of the provider\'s notice' } , ref: 'Provider event handling procedure v1.0', date: '2026-07-15' }),

  'PRM-01': p => ({ r: 'yes', y: `The service schedule lists the purpose and each data element: ${p.personalData.toLowerCase()}`, doc: 'dpa' }),
  'PRM-02': () => ({ r: 'yes', y: 'Yes, a data flow diagram and processing record, reviewed every year and after any change.', doc: 'dpa' }),
  'PRM-03': p => ({ r: 'yes', f: { triggers: 'New data elements, a new subprocessor, a new location or a new way of using the data.', last_assessment: p.dpiaDate }, doc: 'dpa' }),
  'PRM-04': () => ({ r: 'yes', f: { turnaround: 'Within 5 working days', channel: 'The privacy mailbox', escalation: 'Overdue requests go to the DPO, then to the client\'s privacy contact.' }, doc: 'dpa' }),
  'PRM-05': () => ({ r: 'yes', y: 'The retention schedule covers production, replicas, logs and backups; backups expire on their own and are not kept indefinitely.', ref: 'Retention schedule v1.4', date: '2026-02-20' }),
  'PRM-06': () => ({ r: 'yes', doc: 'subprocessors' }),
  'PRM-07': () => ({ r: 'yes', f: { approver: 'Not applicable: never approved so far', protection: 'Test environments use generated data only.' } , ref: 'Test data procedure v1.1', date: '2026-04-22' }),
  'PRM-08': p => ({ r: 'yes', f: { decider: p.dpo.name, reporting_route: 'Written notice to the client\'s privacy contact within 2 working days.' } }),
  'PRM-09': () => ({ t: 'None in the last 24 months.' }),
};

function answersFor(p, ids) {
  const answers = {};
  const missing = [];
  for (const id of ids) {
    if (p.overrides && p.overrides[id]) { answers[id] = p.overrides[id]; continue; }
    if (!A[id]) { missing.push(id); continue; }
    answers[id] = A[id](p);
  }
  return { answers, missing };
}

module.exports = { A, answersFor };
