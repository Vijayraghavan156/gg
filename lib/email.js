const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const APP_NAME = 'Compliance Sphere';
const DEFAULT_FROM = `${APP_NAME} <noreply@isms.local>`;
const DEV_OUTBOX_PATH = path.resolve(process.env.EMAIL_DEV_OUTBOX ||
  path.join(__dirname, '..', 'data', 'email-dev-outbox.log'));

function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getFirmEmailSettings(firmId) {
  if (!firmId) return null;
  let row = await db.prepare('SELECT * FROM firm_email_settings WHERE firm_id=?').get(firmId);
  if (!row) {
    await db.prepare(`INSERT INTO firm_email_settings (firm_id, from_name, from_email, reply_to, enabled)
                VALUES (?, NULL, NULL, NULL, 1) ON CONFLICT (firm_id) DO NOTHING`).run(firmId);
    row = await db.prepare('SELECT * FROM firm_email_settings WHERE firm_id=?').get(firmId);
  }
  return row;
}

async function resolveFrom(firmId, override) {
  if (override) return override;
  const s = firmId ? await getFirmEmailSettings(firmId) : null;
  if (s && s.from_email) {
    return s.from_name ? `${s.from_name} <${s.from_email}>` : s.from_email;
  }
  return process.env.EMAIL_FROM_DEFAULT || DEFAULT_FROM;
}

async function resolveReplyTo(firmId, override) {
  if (override) return override;
  const s = firmId ? await getFirmEmailSettings(firmId) : null;
  return (s && s.reply_to) || null;
}

function renderEmailLayout({ headline, intro, bodyHtml, ctaText, ctaUrl, footnote, fromName }) {
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Roboto,Helvetica,Arial,sans-serif";
  const safeHeadline = escapeHtml(headline || APP_NAME);
  const safeFrom = escapeHtml(fromName || APP_NAME);
  const preheader = escapeHtml(intro || headline || '');
  const cta = ctaText && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px;">
         <tr><td bgcolor="#1a1a1a" style="border-radius:6px;background:#1a1a1a;">
           <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${escapeHtml(ctaText)}</a>
         </td></tr>
       </table>
       <p style="margin:0;font-size:12px;line-height:1.55;color:#8a8a82;font-family:${FONT};">Or paste this link into your browser:<br><a href="${escapeHtml(ctaUrl)}" style="color:#1a1a1a;word-break:break-all;text-decoration:underline;">${escapeHtml(ctaUrl)}</a></p>`
    : '';
  const introBlock = intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#2a2a28;font-family:${FONT};">${escapeHtml(intro)}</p>` : '';
  const foot = footnote ? `<p style="margin:28px 0 0;padding-top:20px;border-top:1px solid #ecebe5;font-size:12px;line-height:1.6;color:#9a9a92;font-family:${FONT};">${footnote}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${safeHeadline}</title></head>
<body style="margin:0;padding:0;background:#fafaf8;font-family:${FONT};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:#fafaf8;font-size:1px;line-height:1px;">${preheader}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafaf8;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dcdad2;border-radius:10px;">
        <tr><td style="padding:20px 36px;border-bottom:1px solid #ecebe5;">
          <span style="font-family:${FONT};font-size:15px;font-weight:500;letter-spacing:-0.01em;color:#1a1a1a;">${safeFrom}</span>
        </td></tr>
        <tr><td style="padding:32px 36px 36px;">
          <h1 style="margin:0 0 18px;font-family:${FONT};font-size:22px;font-weight:500;line-height:1.35;color:#1a1a1a;letter-spacing:-0.4px;">${safeHeadline}</h1>
          ${introBlock}
          ${bodyHtml || ''}
          ${cta}
          ${foot}
        </td></tr>
      </table>
      <div style="margin-top:18px;font-size:11px;line-height:1.5;color:#a8a8a0;font-family:${FONT};letter-spacing:0.02em;">Sent by ${safeFrom} via ${APP_NAME}</div>
    </td></tr>
  </table>
</body></html>`;
}

async function postToBrevo({ from, to, subject, html, text, replyTo }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return { ok: false, error: 'BREVO_API_KEY not set' };

  const verifiedEmail = process.env.BREVO_SENDER_EMAIL || process.env.GMAIL_USER || null;
  const parsed = parseFromHeader(from);
  const senderEmail = verifiedEmail || parsed.email;
  if (!senderEmail) return { ok: false, error: 'No sender email - set BREVO_SENDER_EMAIL.' };
  const sender = parsed.name
    ? { email: senderEmail, name: parsed.name }
    : { email: senderEmail };

  const toList = (Array.isArray(to) ? to : [to]).map(addr => ({ email: addr }));
  const payload = { sender, to: toList, subject, htmlContent: html };
  if (text) payload.textContent = text;
  if (replyTo) {
    const rp = parseFromHeader(replyTo);
    payload.replyTo = rp.name ? { email: rp.email, name: rp.name } : { email: rp.email };
  }

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body.message || body.code || `HTTP ${r.status}` };
    }
    return { ok: true, id: body.messageId || null };
  } catch (e) {
    return { ok: false, error: e.message || 'fetch failed' };
  }
}

function parseFromHeader(raw) {
  if (!raw) return { name: null, email: null };
  const s = String(raw).trim();
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || null, email: m[2] };
  return { name: null, email: s };
}

let _gmailTransport = null;
function getGmailTransport() {
  if (_gmailTransport) return _gmailTransport;
  const nodemailer = require('nodemailer');
  _gmailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '')
    }
  });
  return _gmailTransport;
}

async function postToGmail({ from, to, subject, html, text, replyTo }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return { ok: false, error: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' };
  }
  try {
    const t = getGmailTransport();
    const info = await t.sendMail({
      from: forceGmailFrom(from),
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      html,
      text,
      replyTo
    });
    return { ok: true, id: info.messageId || null };
  } catch (e) {
    return { ok: false, error: e.message || 'smtp send failed' };
  }
}

function forceGmailFrom(rawFrom) {
  const gmailAddr = process.env.GMAIL_USER;
  if (!rawFrom) return gmailAddr;
  const m = String(rawFrom).match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m && m[1]) return `${m[1]} <${gmailAddr}>`;
  return gmailAddr;
}

// Amazon SES through the SESv2 API. There are no mail credentials to manage:
// the AWS SDK signs requests with the credentials of the IAM role the app runs
// as (the ECS task role), so the role needs ses:SendEmail on the sending
// identity. SES_REGION turns this provider on and names the SES region.
function sesConfigured() {
  return !!process.env.SES_REGION;
}

let _sesClient = null;
function getSesClient() {
  if (_sesClient) return _sesClient;
  const { SESv2Client } = require('@aws-sdk/client-sesv2');
  _sesClient = new SESv2Client({ region: process.env.SES_REGION, maxAttempts: 3 });
  return _sesClient;
}

async function postToSes({ from, to, subject, html, text, replyTo }, client = null) {
  if (!sesConfigured()) return { ok: false, error: 'SES_REGION not set' };
  try {
    const { SendEmailCommand } = require('@aws-sdk/client-sesv2');
    const body = {};
    if (html) body.Html = { Data: html, Charset: 'UTF-8' };
    if (text) body.Text = { Data: text, Charset: 'UTF-8' };
    const input = {
      FromEmailAddress: from,
      Destination: { ToAddresses: Array.isArray(to) ? to : [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: body } }
    };
    if (replyTo) input.ReplyToAddresses = [replyTo];
    if (process.env.SES_CONFIGURATION_SET) input.ConfigurationSetName = process.env.SES_CONFIGURATION_SET;
    const out = await (client || getSesClient()).send(new SendEmailCommand(input));
    return { ok: true, id: out && out.MessageId ? out.MessageId : null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'SES send failed' };
  }
}

async function postToResend({ from, to, subject, html, text, replyTo, idempotencyKey }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  const payload = { from, to: Array.isArray(to) ? to : [to], subject, html };
  if (text) payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: JSON.stringify(payload)
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, error: body.message || body.error || `HTTP ${r.status}` };
    }
    return { ok: true, id: body.id || null };
  } catch (e) {
    return { ok: false, error: e.message || 'fetch failed' };
  }
}

function writeDevOutbox(record) {
  try {
    const line = `\n===== ${new Date().toISOString()} =====\nFROM: ${record.from}\nTO:   ${record.to}\nSUBJ: ${record.subject}\n\n${record.text || stripHtml(record.html)}\n`;
    fs.appendFileSync(DEV_OUTBOX_PATH, line, 'utf8');
  } catch (_) { }
}

async function sendEmail({
  to,
  subject,
  html,
  text,
  fromOverride,
  replyToOverride,
  firmId = null,
  workspaceId = null,
  relatedType = null,
  relatedId = null,
  idempotencyKey = null,
  outboxRedactions = []
}) {
  if (!to || !subject) {
    throw new Error('sendEmail: to and subject are required');
  }
  if (idempotencyKey != null && !/^[\x21-\x7e]{1,256}$/.test(String(idempotencyKey))) throw new Error('Invalid email idempotency key.');
  const from = await resolveFrom(firmId, fromOverride);
  const replyTo = await resolveReplyTo(firmId, replyToOverride);
  const finalText = text || stripHtml(html);
  const finalHtml = html || `<p>${escapeHtml(finalText)}</p>`;

  const deliveryDisabled = process.env.EMAIL_DELIVERY_DISABLED === '1';
  const hasSes    = !deliveryDisabled && sesConfigured();
  const hasBrevo  = !deliveryDisabled && !!process.env.BREVO_API_KEY;
  const hasGmail  = !deliveryDisabled && !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const hasResend = !deliveryDisabled && !!process.env.RESEND_API_KEY;
  let provider, ok, providerId = null, error = null;

  if (deliveryDisabled) {
    provider = 'disabled';
    ok = true;
  } else if (hasSes) {
    provider = 'ses';
    const r = await postToSes({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else if (hasBrevo) {
    provider = 'brevo';
    const r = await postToBrevo({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else if (hasGmail) {
    provider = 'gmail';
    const r = await postToGmail({ from, to, subject, html: finalHtml, text: finalText, replyTo });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else if (hasResend) {
    provider = 'resend';
    const r = await postToResend({ from, to, subject, html: finalHtml, text: finalText, replyTo, idempotencyKey });
    ok = r.ok;
    providerId = r.id;
    error = r.error || null;
  } else {
    provider = 'devnull';
    ok = true;
    writeDevOutbox({ from, to, subject, html: finalHtml, text: finalText });
  }

  const status = ok ? 'sent' : 'failed';
  const sentAt = ok ? new Date().toISOString() : null;

  // Secrets the stored copy must not keep (a link that is its own credential):
  // the message is delivered as written, the outbox keeps it without them.
  const redact = (value) => {
    let out = value;
    for (const secret of outboxRedactions || []) {
      if (secret) out = String(out).split(String(secret)).join('[link removed]');
    }
    return out;
  };
  const storedHtml = redact(finalHtml);
  const storedText = redact(finalText);

  const insertId = (await db.prepare(`INSERT INTO email_outbox
    (firm_id, workspace_id, to_email, from_email, subject, body_html, body_text,
     related_type, related_id, status, provider, provider_message_id, error_message, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    firmId, workspaceId,
    Array.isArray(to) ? to.join(', ') : to,
    from, subject, storedHtml, storedText,
    relatedType, relatedId == null ? null : String(relatedId),
    status, provider, providerId, error, sentAt
  )).lastInsertRowid;

  return { ok, id: insertId, provider, providerId, error };
}

async function sendTestEmail(firmId, to) {
  const baseUrl = appBaseUrl();
  const html = renderEmailLayout({
    headline: 'Email delivery is wired up',
    intro: `This is a test message from ${APP_NAME}. If you can read it, transactional mail (policy approval requests, audit invites, NC assignments) will reach this inbox the same way.`,
    bodyHtml: `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">No action needed - this is just a connectivity check.</p>`,
    ctaText: `Open ${APP_NAME}`,
    ctaUrl: baseUrl,
    footnote: `Provider: ${process.env.RESEND_API_KEY ? 'Resend' : 'dev fallback (no RESEND_API_KEY configured)'}. To change the From address, open Admin → Email.`,
    fromName: APP_NAME
  });
  return await sendEmail({
    to,
    subject: `[${APP_NAME}] Test email - delivery is working`,
    html,
    firmId,
    relatedType: 'test',
    relatedId: null
  });
}

async function sendMagicLinkApprovalEmail({
  toEmail, toName, docName, docVersion, workspaceName,
  workspaceId, firmId, submitterName, token, sequence,
  totalApprovers, roleLabel, expiresAt, changeSummary, relatedDocId
}) {
  const baseUrl = appBaseUrl();
  const approveUrl = `${baseUrl}/approve/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const seqLine = totalApprovers > 1
    ? `You are approver #${sequence} of ${totalApprovers} in the chain.`
    : 'You are the sole approver on this document.';
  const expiryStr = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${escapeHtml(submitterName || 'The ISMS team')}</strong> at <strong>${escapeHtml(workspaceName)}</strong> is asking for your approval on a policy document. ${escapeHtml(seqLine)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;border:1px solid #ecebe5;border-radius:6px;background:#fafaf8;">
      <tr><td style="padding:14px 18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,system-ui,Arial,sans-serif;">
        <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9c9ca5;margin-bottom:6px;">Document</div>
        <div style="font-size:15px;font-weight:500;color:#1a1a1a;margin-bottom:6px;">${escapeHtml(docName)} <span style="color:#9c9ca5;font-weight:400;">· v${docVersion}</span></div>
        ${roleLabel ? `<div style="font-size:12px;color:#71717a;margin-bottom:8px;">Acting as: ${escapeHtml(roleLabel)}</div>` : ''}
        ${changeSummary ? `<div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#9c9ca5;margin:10px 0 4px;">Summary of changes</div><div style="font-size:13px;line-height:1.55;color:#51525c;">${escapeHtml(changeSummary)}</div>` : ''}
      </td></tr>
    </table>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">Click the button below to review the full document and approve or reject it. You don't need an account - the link itself is your credential.</p>`;

  const footnote = `This link is unique to you and expires on <strong>${escapeHtml(expiryStr)}</strong>. Treat it like a password - anyone who has it can decide on your behalf. Your decision is recorded with the IP address and time, and shows up on the document's audit trail.`;

  return await sendEmail({
    to: toEmail,
    subject: `[${workspaceName}] Approval requested: ${docName} (v${docVersion})`,
    html: renderEmailLayout({
      headline: 'A document is ready for your approval',
      bodyHtml,
      ctaText: 'Review and decide',
      ctaUrl: approveUrl,
      footnote,
      fromName: workspaceName
    }),
    firmId,
    workspaceId,
    relatedType: 'doc_approval_magic_link',
    relatedId: relatedDocId
  });
}

async function sendAcknowledgementEmail({ toEmail, toName, documentName, versionNumber, workspaceName, workspaceId, firmId, token, dueDate, campaignId }) {
  const url = `${appBaseUrl()}/ack/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${escapeHtml(workspaceName)}</strong> asks you to read <strong>${escapeHtml(documentName)}</strong> (version ${escapeHtml(String(versionNumber))}) and confirm that you have read it${dueDate ? ` by ${escapeHtml(dueDate)}` : ''}.</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">The link below opens the document. You don't need an account.</p>`;
  return await sendEmail({
    to: toEmail,
    subject: `[${workspaceName}] Please read and acknowledge: ${documentName}`,
    html: renderEmailLayout({
      headline: 'A document for you to read',
      bodyHtml,
      ctaText: 'Read and acknowledge',
      ctaUrl: url,
      footnote: 'This link is unique to you. Please don\'t forward it.',
      fromName: workspaceName,
    }),
    firmId,
    workspaceId,
    relatedType: 'doc_ack_campaign',
    relatedId: campaignId || null,
  });
}

async function sendVendorQuestionnaireEmail({ toEmail, toName, clientName, url, expiresAt, workspaceId, firmId, requestId,
  firmName = '', expiryDay = '', contact = null, facts = null, override = null, thirdPartyName = '', renderOnly = false }) {
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif";
  const para = (html, color = '#1b1f24') => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${color};font-family:${FONT};">${html}</p>`;
  const from = firmName || clientName;
  const until = expiryDay || new Date(expiresAt).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const parts = [para(escapeHtml(toName ? `Dear ${toName},` : 'Hello,'))];
  parts.push(para(firmName
    ? `${escapeHtml(firmName)} is reviewing, on behalf of <strong>${escapeHtml(clientName)}</strong>, the security of the services you provide to them, and asks you to answer a security questionnaire.`
    : `<strong>${escapeHtml(clientName)}</strong> asks you to answer a security questionnaire about the services you provide to them.`));
  parts.push(para(`Please submit your answers by <strong>${escapeHtml(until)}</strong>, when the link stops working.`));
  if (facts && facts.total) {
    parts.push(para(`There are ${escapeHtml(plural(facts.total, 'question'))} in ${escapeHtml(plural(facts.sections, 'section'))}. You can stop and return at any time: what you save stays there until you submit. You don't need an account.`));
    if (facts.documentGroups && facts.documentGroups.length) {
      const items = facts.documentGroups.map(g => `<li style="margin:0 0 4px;">${escapeHtml(g.group)} (${g.count})</li>`).join('');
      parts.push(para('It will help to have these documents to hand:'));
      parts.push(`<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.6;color:#1b1f24;font-family:${FONT};">${items}</ul>`);
    } else if (facts.documentRequests) {
      parts.push(para(`${escapeHtml(plural(facts.documentRequests, 'answer asks', 'answers ask'))} for a supporting document, often the same policy or report for several. The first page of the questionnaire lists them.`));
    }
  }
  const o = override || {};
  const fillD = { clientName, thirdPartyName, firmName, toName, until };
  const own = txt => String(fillTprmPlaceholders(txt, fillD)).split(/\n{2,}/).map(x => x.trim()).filter(Boolean).map(x => para(escapeHtml(x)));
  if (o.opening) parts.splice(1, 0, ...own(o.opening));
  if (o.closing) parts.push(...own(o.closing));
  if (contact && contact.email) {
    parts.push(para(`If anything is unclear, write to ${contact.name ? `${escapeHtml(contact.name)} at ` : ''}<a href="mailto:${escapeHtml(contact.email)}" style="color:#1f3a5f;">${escapeHtml(contact.email)}</a>.`));
  }
  const subject = (o.subject && fillTprmPlaceholders(o.subject, fillD)) || (firmName ? `Security questionnaire from ${firmName} for ${clientName}` : `[${clientName}] Security questionnaire for you to answer`);
  const html = renderEmailLayout({
    headline: (o.headline && fillTprmPlaceholders(o.headline, fillD)) || `Security questionnaire for ${clientName}`,
    bodyHtml: parts.join('\n'),
    ctaText: 'Open the questionnaire',
    ctaUrl: url,
    footnote: `This link is personal to you and stops working on <strong>${escapeHtml(until)}</strong>. Please don't forward it: anyone who has it can answer on your behalf.`,
    fromName: from,
  });
  if (renderOnly) return { subject, html };
  return await sendEmail({
    to: toEmail,
    subject,
    html,
    firmId,
    workspaceId,
    relatedType: 'tp_vendor_request',
    relatedId: requestId || null,
    outboxRedactions: [url, String(url).split('/').pop()],
  });
}

const TP_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif";
const tpPara = html => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#1b1f24;font-family:${TP_FONT};">${html}</p>`;
const tpQuote = text => `<p style="margin:0 0 14px;padding-left:12px;border-left:2px solid #dcdad2;font-size:14px;line-height:1.6;color:#3a3d42;font-family:${TP_FONT};">${escapeHtml(text)}</p>`;
const tpList = items => `<ul style="margin:0 0 14px;padding-left:20px;font-size:14px;line-height:1.6;color:#1b1f24;font-family:${TP_FONT};">${items.map(i => `<li style="margin:0 0 6px;">${i}</li>`).join('')}</ul>`;
const tpPlural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tpClip = (v, max = 400) => { const t = String(v == null ? '' : v).trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t; };
const e = escapeHtml;
const tpDear = d => tpPara(e(d.toName ? `Dear ${d.toName},` : 'Hello,'));
const tpHi = d => tpPara(e(d.toName ? `Hi ${d.toName},` : 'Hi,'));
const tpContact = (d, lead = 'If anything is unclear, write to') => (d.contact && d.contact.email
  ? tpPara(`${lead} ${d.contact.name ? `${e(d.contact.name)} at ` : ''}<a href="mailto:${e(d.contact.email)}" style="color:#1f3a5f;">${e(d.contact.email)}</a>.`)
  : '');
const tpFrom = d => (d.firmName ? `${e(d.firmName)}, on behalf of <strong>${e(d.clientName)}</strong>,` : `<strong>${e(d.clientName)}</strong>`);
const tpProgress = d => (d.total ? ` ${d.answered || 0} of ${tpPlural(d.total, 'question')} ${d.answered === 1 ? 'is' : 'are'} answered so far.` : '');
const TP_USER_FOOT = 'You are getting this because email notifications are on for your account. You can turn them off in your profile.';
const TP_NO_LINK_FOOT = 'This reminder does not include the link: use the one you were sent.';
const tpLinkFoot = d => `This is the same link you were sent on ${e(d.sentDay)}. It is personal to you and stops working on <strong>${e(d.until)}</strong>. Please don't forward it: anyone who has it can answer on your behalf.`;

const TPRM_TEMPLATES = Object.freeze({
  vendor_reminder_7: d => ({
    subject: `Reminder: security questionnaire for ${d.clientName}, due ${d.until}`,
    headline: `Your security questionnaire for ${d.clientName} is due on ${d.until}`,
    paras: [tpDear(d),
      tpPara(`This is a reminder about the security questionnaire ${tpFrom(d)} sent you on ${e(d.sentDay)}. Please submit your answers by <strong>${e(d.until)}</strong>, when the link stops working.${e(tpProgress(d))}`),
      tpPara(d.url ? 'Open it with the button below. What you saved is still there, and you do not need an account.'
        : 'Open it with the same link. What you saved is still there, and you do not need an account.'),
      tpContact(d, d.url ? 'If you need more time, write to' : 'If you cannot find the link or need more time, write to')],
    ctaText: d.url ? 'Open the questionnaire' : null, ctaUrl: d.url || null,
    footnote: d.url ? tpLinkFoot(d) : TP_NO_LINK_FOOT,
  }),
  vendor_reminder_1: d => ({
    subject: `Due tomorrow: security questionnaire for ${d.clientName}`,
    headline: `Your security questionnaire for ${d.clientName} is due tomorrow`,
    paras: [tpDear(d),
      tpPara(`The link to the security questionnaire ${tpFrom(d)} sent you on ${e(d.sentDay)} stops working on <strong>${e(d.until)}</strong>.${e(tpProgress(d))}`),
      tpPara(d.url ? 'Open it with the button below and submit your answers before then.' : 'Open it with the same link and submit your answers before then.'),
      tpContact(d, d.url ? 'If you need more time, write to' : 'If you cannot find the link or need more time, write to')],
    ctaText: d.url ? 'Open the questionnaire' : null, ctaUrl: d.url || null,
    footnote: d.url ? tpLinkFoot(d) : TP_NO_LINK_FOOT,
  }),
  vendor_overdue: d => ({
    subject: `Security questionnaire for ${d.clientName}: the link has stopped working`,
    headline: 'The questionnaire link has stopped working',
    paras: [tpDear(d),
      tpPara(`The link to the security questionnaire ${tpFrom(d)} sent you on ${e(d.sentDay)} stopped working on <strong>${e(d.until)}</strong> before your answers were submitted.${e(tpProgress(d))} What you saved is kept.`),
      tpContact(d, 'To finish it, write to') || tpPara('To finish it, ask the person who sent it for a new link.')],
    footnote: 'A new link, when you get one, opens the answers you saved.',
  }),
  vendor_receipt: d => ({
    subject: `Received: your security questionnaire for ${d.clientName}`,
    headline: 'Thank you: your answers were received',
    paras: [tpDear(d),
      tpPara(`Your answers to the security questionnaire for <strong>${e(d.clientName)}</strong> were received on ${e(d.submittedDay)}: ${e(tpPlural(d.total || 0, 'question'))}${d.files ? ` and ${e(tpPlural(d.files, 'document'))}` : ''}.`),
      tpPara(`${d.firmName ? e(d.firmName) : e(d.clientName)} will review them and write to you if anything needs clarifying.`),
      tpContact(d, 'If you have a question meanwhile, write to')],
    footnote: 'You do not need to do anything else.',
  }),
  vendor_clarification: d => ({
    subject: `A question about your answers for ${d.clientName}`,
    headline: `A question about your answers for ${d.clientName}`,
    paras: [tpDear(d),
      tpPara(`While reviewing your security questionnaire, ${d.firmName ? e(d.firmName) : e(d.clientName)} has a question${d.questionId ? ` about ${e(d.questionId)}` : ''}:`),
      tpQuote(tpClip(d.body, 1000)),
      d.url ? tpPara('Answer it with the button below. Only the question is open: your other answers stay as you submitted them.')
        : tpPara(`Answer it with the link you were sent on ${e(d.sentDay)}, which works until ${e(d.until)}. Only the question is open: your other answers stay as you submitted them.`),
      tpContact(d)],
    ctaText: d.url ? 'Answer the question' : null,
    ctaUrl: d.url || null,
    footnote: d.url ? `This link is personal to you and stops working on <strong>${e(d.until)}</strong>. Please don't forward it: anyone who has it can answer on your behalf.` : 'This email does not include the link: use the one you were sent.',
  }),
  conditions_link: d => ({
    subject: `Conditions agreed for ${d.clientName}: please send your proof`,
    headline: `Conditions to meet for ${d.clientName}`,
    paras: [tpDear(d),
      tpPara(`${tpFrom(d)} asks you for proof that ${(d.conditions || []).length === 1 ? 'this condition is' : 'these conditions are'} met:`),
      tpList((d.conditions || []).map(c => `${e(c.text)}${c.due ? ` <span style="color:#6b6f76;">(by ${e(c.due)})</span>` : ''}`)),
      tpPara('Open the page with the button below and attach a document or write a note for each. You do not need an account.'),
      tpContact(d)],
    ctaText: 'Send proof',
    ctaUrl: d.url,
    footnote: `This link is personal to you and stops working on <strong>${e(d.until)}</strong>. Please don't forward it.`,
  }),
  consultant_submitted: d => ({
    subject: `[${d.clientName}] ${d.thirdPartyName} submitted the questionnaire`,
    headline: `${d.thirdPartyName} submitted the questionnaire`,
    paras: [tpHi(d),
      tpPara(`${e(d.thirdPartyName)} submitted the questionnaire for ${e(d.clientName)} on ${e(d.submittedDay)}: ${e(tpPlural(d.total || 0, 'question'))}${d.files ? ` and ${e(tpPlural(d.files, 'document'))}` : ''}. The answers are ready to review.`)],
    ctaText: 'Review the answers', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  consultant_clarification_answered: d => ({
    subject: `[${d.clientName}] ${d.thirdPartyName} answered a clarification`,
    headline: `${d.thirdPartyName} answered a clarification`,
    paras: [tpHi(d),
      tpPara(`${e(d.thirdPartyName)} answered your question${d.questionId ? ` on ${e(d.questionId)}` : ''}:`),
      tpQuote(tpClip(d.response, 600)),
      d.withFile ? tpPara('They attached a document.') : ''],
    ctaText: 'Open the answer', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  consultant_client_decided: d => ({
    subject: `[${d.clientName}] Decision on ${d.thirdPartyName}: ${d.outcomeLabel}`,
    headline: `${d.clientName} decided on ${d.thirdPartyName}`,
    paras: [tpHi(d),
      tpPara(`${e(d.deciderName || 'The client')} recorded the decision <strong>${e(d.outcomeLabel)}</strong> on version ${e(String(d.version || 1))} of the recommendation${d.diverges ? `, which differs from the recommendation (${e(d.recommendedLabel || '')}). The risk is accepted until ${e(d.riskUntil || '')}` : ''}.`),
      d.rationale ? tpQuote(tpClip(d.rationale, 600)) : ''],
    ctaText: 'Open the assessment', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  consultant_proof_uploaded: d => ({
    subject: `[${d.clientName}] ${d.thirdPartyName} sent proof for condition ${d.position}`,
    headline: `Proof to verify from ${d.thirdPartyName}`,
    paras: [tpHi(d),
      tpPara(`${e(d.thirdPartyName)} sent proof for condition ${e(String(d.position))}${d.files ? ` (${e(tpPlural(d.files, 'file'))})` : ''}:`),
      tpQuote(tpClip(d.conditionText, 400)),
      d.note ? tpPara(`Their note: ${e(tpClip(d.note, 400))}`) : ''],
    ctaText: 'Verify the proof', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  client_decision_needed: d => ({
    subject: `Decision needed: ${d.thirdPartyName}`,
    headline: `Your decision is needed on ${d.thirdPartyName}`,
    paras: [tpHi(d),
      tpPara(`${d.firmName ? e(d.firmName) : 'Your consultants'} issued the recommendation on ${e(d.thirdPartyName)}: <strong>${e(d.outcomeLabel)}</strong>.`),
      tpPara('As the decision owner, please read it and record your decision. The page explains what was found and what each choice means.')],
    ctaText: 'Read and decide', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  client_decision_reminder: d => ({
    subject: `Reminder: decision needed on ${d.thirdPartyName}`,
    headline: `${d.thirdPartyName} is waiting for your decision`,
    paras: [tpHi(d),
      tpPara(`The recommendation on ${e(d.thirdPartyName)} (<strong>${e(d.outcomeLabel)}</strong>) was issued on ${e(d.issuedDay)} and is waiting for your decision.`)],
    ctaText: 'Read and decide', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  vendor_issue_shared: d => ({
    subject: `An issue from your security review for ${d.clientName}`,
    headline: `${d.firmName || d.clientName} has shared an issue with you`,
    paras: [tpDear(d),
      tpPara(`While reviewing your security questionnaire for <strong>${e(d.clientName)}</strong>, the reviewers found something they would like you to look at:`),
      tpPara(`<strong>${e(d.issueTitle)}</strong>`),
      tpQuote(tpClip(d.issueBody, 1200)),
      tpPara(d.url ? `${d.signIn ? 'Sign in with the button below' : 'Open the issue with the button below'} to respond, or to propose a fix and the date it will be done.`
        : `Open the issue with the link you were sent on ${e(d.sentDay)} to respond, or to propose a fix and the date it will be done.`),
      tpContact(d)],
    ctaText: d.url ? (d.signIn ? 'Sign in to open the issue' : 'Open the issue') : null, ctaUrl: d.url || null,
    footnote: d.signIn ? 'Sign in with this email address. We will email you a code: there is no password.' : d.url ? tpLinkFoot(d) : 'This email does not include the link: use the one you were sent.',
  }),
  vendor_issue_update: d => ({
    subject: d.agreed ? `Fix agreed: ${d.issueTitle}` : `A reply on an issue from your security review for ${d.clientName}`,
    headline: d.agreed ? 'Your proposed fix was agreed' : `${d.firmName || d.clientName} replied on an issue`,
    paras: [tpDear(d),
      tpPara(d.agreed ? `The reviewers agreed your proposed fix for <strong>${e(d.issueTitle)}</strong>:` : `The reviewers replied on the issue <strong>${e(d.issueTitle)}</strong>:`),
      tpQuote(d.agreed ? `${tpClip(d.agreedFix, 600)}${d.agreedDay ? ` (by ${d.agreedDay})` : ''}` : tpClip(d.body, 1200)),
      tpPara(d.agreed ? 'It will be tracked as a condition of the review. You will be asked for proof when it is done.'
        : (d.url ? `${d.signIn ? 'Sign in with the button below' : 'Open the issue with the button below'} to respond.` : `Open the issue with the link you were sent on ${e(d.sentDay)} to respond.`)),
      tpContact(d)],
    ctaText: d.url ? (d.signIn ? 'Sign in to open the issue' : 'Open the issue') : null, ctaUrl: d.url || null,
    footnote: d.signIn ? 'Sign in with this email address. We will email you a code: there is no password.' : d.url ? tpLinkFoot(d) : 'This email does not include the link: use the one you were sent.',
  }),
  vendor_invited: d => ({
    subject: `${d.inviterName} added you to the third-party portal${d.firmName ? ` of ${d.firmName}` : ''}`,
    headline: `You can now help ${d.thirdPartyName} answer security reviews`,
    paras: [tpDear(d),
      tpPara(`${e(d.inviterName)} added you as a colleague at <strong>${e(d.thirdPartyName)}</strong> for the security reviews ${d.firmName ? `${e(d.firmName)} runs ` : ''}for ${e(d.clientName)}.`),
      tpPara('Sign in with this email address. We will email you a code each time: there is no password to remember.'),
      tpContact(d, 'If you were not expecting this, write to')],
    ctaText: 'Sign in', ctaUrl: d.url,
    footnote: 'You were added by a person at your own company. Ask them if you are not sure why.',
  }),
  vendor_sections_assigned: d => ({
    subject: `${d.inviterName} asked you to answer ${d.sections.length === 1 ? 'a section' : 'sections'} of a security questionnaire`,
    headline: `Sections for you to answer for ${d.clientName}`,
    paras: [tpDear(d),
      tpPara(`${e(d.inviterName)} asked you to answer these sections of the security questionnaire for <strong>${e(d.clientName)}</strong>:`),
      tpList((d.sections || []).map(s => e(s))),
      tpPara(`Sign in to answer them. ${e(d.inviterName)} submits the questionnaire when everything is answered.`)],
    ctaText: 'Sign in', ctaUrl: d.url,
    footnote: 'Sign in with this email address. We will email you a code.',
  }),
  vendor_sign_in_code: d => ({
    subject: `Your sign-in code for ${d.firmName || 'the third-party portal'}`,
    headline: `Your sign-in code is ${d.code}`,
    paras: [tpPara('Hello,'),
      tpPara(`Use the code <strong style="font-size:18px;letter-spacing:2px;">${e(d.code)}</strong> to sign in to the third-party portal${d.firmName ? ` of ${e(d.firmName)}` : ''}. It works once, for ${e(String(d.minutes || 10))} minutes.`),
      tpPara('If you did not ask to sign in, you can ignore this email: no one can sign in without the code.')],
    ctaText: null, ctaUrl: null,
    footnote: 'Never share this code. The firm will never ask you for it.',
  }),
  consultant_issue_reply: d => ({
    subject: `[${d.clientName}] ${d.thirdPartyName} ${d.proposed ? 'proposed a fix' : 'replied'}: ${d.issueTitle}`,
    headline: `${d.thirdPartyName} ${d.proposed ? 'proposed a fix' : 'replied on an issue'}`,
    paras: [tpHi(d),
      tpPara(`${e(d.thirdPartyName)} ${d.proposed ? 'proposed a fix for' : 'replied on'} the issue <strong>${e(d.issueTitle)}</strong>:`),
      d.proposedFix ? tpQuote(`${tpClip(d.proposedFix, 600)}${d.proposedDay ? ` (by ${d.proposedDay})` : ''}`) : '',
      d.body ? tpQuote(tpClip(d.body, 600)) : ''],
    ctaText: 'Open the issue', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  consultant_client_comment: d => ({
    subject: `[${d.clientName}] Client comment on ${d.thirdPartyName}: ${d.issueTitle}`,
    headline: `${d.clientName} commented on an issue`,
    paras: [tpHi(d),
      tpPara(`${e(d.authorName || d.clientName)} at ${e(d.clientName)} commented on the issue <strong>${e(d.issueTitle)}</strong> for ${e(d.thirdPartyName)}:`),
      d.body ? tpQuote(tpClip(d.body, 600)) : '',
      tpPara(d.private ? 'This finding was not shared with the third party: only your firm and the client see this conversation.' : 'The third party sees this comment too.')],
    ctaText: 'Open the issue', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  consultant_client_request: d => ({
    subject: `[${d.clientName}] Request to add ${d.supplierName || 'a new supplier'}`,
    headline: `${d.clientName} asked you to review a new supplier`,
    paras: [tpHi(d),
      tpPara(`${e(d.authorName || d.clientName)} at ${e(d.clientName)} asked for <strong>${e(d.supplierName || 'a new supplier')}</strong> to be added as a third party.`),
      d.service ? tpQuote(tpClip(d.service, 600)) : '',
      tpPara('Add it as a proposed third party, or decline with a reason the client sees.')],
    ctaText: 'Open the request', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
  client_condition_due: d => ({
    subject: `Condition due ${d.dueDay}: ${d.thirdPartyName}`,
    headline: `A condition you own is due on ${d.dueDay}`,
    paras: [tpHi(d),
      tpPara(`Condition ${e(String(d.position))} on ${e(d.thirdPartyName)}, which your organisation agreed to meet, is due on <strong>${e(d.dueDay)}</strong>:`),
      tpQuote(tpClip(d.conditionText, 400)),
      tpPara('When it is done, tell your consultants so they can verify it.')],
    ctaText: 'Open the recommendation', ctaUrl: d.url, footnote: TP_USER_FOOT,
  }),
});

function fillTprmPlaceholders(text, d) {
  const values = { client: d.clientName, supplier: d.thirdPartyName, firm: d.firmName, name: d.toName, due: d.until || d.dueDay };
  return String(text || '').replace(/\{(client|supplier|firm|name|due)\}/gi, (all, k) => {
    const v = values[k.toLowerCase()];
    return v == null || v === '' ? '' : String(v);
  }).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function renderTprmEmail(kind, d, override = null) {
  const t = TPRM_TEMPLATES[kind];
  if (!t) throw new Error(`Unknown TPRM message: ${kind}`);
  const m = t(d);
  const o = override || {};
  const subject = o.subject ? fillTprmPlaceholders(o.subject, d) || m.subject : m.subject;
  const headline = o.headline ? fillTprmPlaceholders(o.headline, d) || m.headline : m.headline;
  const paras = m.paras.filter(Boolean);
  const own = txt => String(fillTprmPlaceholders(txt, d)).split(/\n{2,}/).map(x => x.trim()).filter(Boolean).map(x => tpPara(e(x)));
  if (o.opening) paras.splice(paras.length ? 1 : 0, 0, ...own(o.opening));
  if (o.closing) paras.push(...own(o.closing));
  return {
    subject,
    html: renderEmailLayout({
      headline, bodyHtml: paras.join('\n'), ctaText: m.ctaText || null, ctaUrl: m.ctaUrl || null,
      footnote: m.footnote, fromName: d.firmName || d.clientName,
    }),
  };
}

async function sendPasswordResetEmail({ toEmail, toName, token, expiresAt, firmId = null }) {
  const baseUrl = appBaseUrl();
  const resetUrl = `${baseUrl}/reset/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const expiryStr = new Date(expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">We received a request to reset the password on your ${APP_NAME} account (<strong>${escapeHtml(toEmail)}</strong>). Use the button below to choose a new one.</p>
    <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">If you didn't ask for this, you can safely ignore the message - your existing password stays valid.</p>`;

  const footnote = `This link is single-use and expires on <strong>${escapeHtml(expiryStr)}</strong>. If it expires before you use it, request another reset from the sign-in page.`;

  return await sendEmail({
    to: toEmail,
    subject: `[${APP_NAME}] Reset your password`,
    html: renderEmailLayout({
      headline: 'Reset your password',
      bodyHtml,
      ctaText: 'Choose a new password',
      ctaUrl: resetUrl,
      footnote,
      fromName: APP_NAME
    }),
    firmId,
    relatedType: 'password_reset',
    relatedId: null
  });
}

async function sendInviteEmail({ toEmail, toName, inviterName, firmName, role, token, expiresAt, firmId = null }) {
  const baseUrl = appBaseUrl();
  const acceptUrl = `${baseUrl}/invite/${token}`;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const expiryStr = new Date(expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  const roleLine = role ? ` as a <strong>${escapeHtml(role)}</strong>` : '';

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;"><strong>${escapeHtml(inviterName || 'A teammate')}</strong> has invited you to join <strong>${escapeHtml(firmName || APP_NAME)}</strong>${roleLine}. Click the button below to set your password and sign in.</p>`;

  const footnote = `This invitation is single-use and expires on <strong>${escapeHtml(expiryStr)}</strong>. If it expires, ask the person who invited you for a new link.`;

  return await sendEmail({
    to: toEmail,
    subject: `[${APP_NAME}] You're invited to join ${firmName || APP_NAME}`,
    html: renderEmailLayout({
      headline: 'You\'re invited',
      bodyHtml,
      ctaText: 'Accept invitation',
      ctaUrl: acceptUrl,
      footnote,
      fromName: firmName || APP_NAME
    }),
    firmId,
    relatedType: 'user_invite',
    relatedId: null
  });
}

async function sendNotificationEmail({
  toEmail, toName, title, body, link, workspaceName,
  firmId = null, workspaceId = null, category = null, idempotencyKey = null
}) {
  const baseUrl = appBaseUrl();
  const ctaUrl = link ? (/^https?:\/\//i.test(link) ? link : baseUrl + link) : null;
  const greeting = toName ? `Hi ${toName},` : 'Hi,';
  const ctx = workspaceName
    ? `This relates to <strong>${escapeHtml(workspaceName)}</strong>.`
    : `This is an update from ${APP_NAME}.`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#27272a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(greeting)}</p>
    ${body ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#51525c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${escapeHtml(body)}</p>` : ''}
    <p style="margin:0 0 16px;font-size:13px;line-height:1.55;color:#71717a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif;">${ctx}</p>`;

  return await sendEmail({
    to: toEmail,
    subject: workspaceName ? `[${workspaceName}] ${title}` : `[${APP_NAME}] ${title}`,
    html: renderEmailLayout({
      headline: title,
      bodyHtml,
      ctaText: ctaUrl ? `Open in ${APP_NAME}` : null,
      ctaUrl,
      footnote: `You're getting this because email notifications are on for your account. Turn them off anytime from your inbox in the app.`,
      fromName: workspaceName || APP_NAME
    }),
    firmId,
    workspaceId,
    relatedType: category ? `notification:${category}` : 'notification',
    relatedId: null,
    idempotencyKey
  });
}

function currentProvider() {
  if (sesConfigured()) return 'ses';
  if (process.env.BREVO_API_KEY) return 'brevo';
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'gmail';
  if (process.env.RESEND_API_KEY) return 'resend';
  return 'devnull';
}

module.exports = {
  sendEmail,
  sendAcknowledgementEmail,
  sendVendorQuestionnaireEmail,
  sendTestEmail,
  sendMagicLinkApprovalEmail,
  sendPasswordResetEmail,
  sendInviteEmail,
  sendNotificationEmail,
  renderEmailLayout,
  TPRM_TEMPLATES,
  renderTprmEmail, fillTprmPlaceholders,
  getFirmEmailSettings,
  currentProvider,
  sesConfigured,
  _postToSes: postToSes,
  stripHtml,
  escapeHtml,
  appBaseUrl
};
