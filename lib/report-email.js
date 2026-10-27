const nodemailer = require('nodemailer');
const { RequestError } = require('./request-error');
const { duration } = require('./reports');

function createReportMailer({ env = process.env, mail = nodemailer } = {}) {
  let configuration;
  async function configure() {
    const smtp = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'].some(key => env[key]);
    const timeouts = { connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000 };
    if (smtp) {
      const port = Number(env.SMTP_PORT || 587);
      if (!env.SMTP_HOST || !env.SMTP_FROM || !Number.isInteger(port) || port < 1 || port > 65535 ||
          (!!env.SMTP_USER !== !!env.SMTP_PASS) || (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE))) {
        throw new Error('Invalid SMTP configuration');
      }
      return { preview: false, from: env.SMTP_FROM, transport: mail.createTransport({
        host: env.SMTP_HOST, port, secure: env.SMTP_SECURE === 'true',
        requireTLS: env.SMTP_SECURE !== 'true', ...timeouts,
        ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {})
      }) };
    }
    let timer;
    const account = await Promise.race([mail.createTestAccount(), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Preview account request timed out')), 10000);
    })]).finally(() => clearTimeout(timer));
    return { preview: true, from: 'Alisto preview <reports@alisto.example>', transport: mail.createTransport({
      host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure,
      requireTLS: !account.smtp.secure,
      auth: { user: account.user, pass: account.pass }, ...timeouts
    }) };
  }

  return { async send(report, csv, filename) {
    try {
      if (!configuration) configuration = configure().catch(error => { configuration = undefined; throw error; });
      const { transport, preview, from } = await configuration;
      const student = report.self;
      const percent = value => value == null ? 'N/A' : `${value.toFixed(2)}%`;
      const info = await transport.sendMail({ from, to: { name: student.name, address: student.email },
        subject: `Alisto report · Session ${report.session.id}`,
        text: [`${report.session.class_title} · ${report.completion_label}`,
          `Session: ${report.session.id} · ${new Date(report.session.started_at).toISOString()}`,
          `Saved cutoff: ${new Date(report.session.ended_at).toISOString()}`,
          `Student: ${student.name}`, report.measurement_label,
          `Final status: ${student.status}`, `Active after grace: ${duration(student.active_seconds)}`,
          `Measured after grace: ${duration(student.total_seconds)}`,
          `Cannot verify (excluded since enrollment): ${report.session.source === 'meet' ? duration(student.excluded_seconds) : 'N/A (legacy)'}`,
          `Activity Rate: ${percent(student.activity_rate)}`,
          `Participation: ${student.participation.responded_count}/${student.participation.eligible_count}`,
          `Participation Rate: ${percent(student.participation.participation_rate)} · ${student.participation.classification}`,
          report.notice, ...(preview ? ['PREVIEW ONLY: this message is not delivered to a real inbox.'] : [])].join('\n'),
        attachments: [{ filename, content: csv, contentType: 'text/csv; charset=utf-8' }],
        disableFileAccess: true, disableUrlAccess: true
      });
      if (preview) {
        const url = mail.getTestMessageUrl(info);
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'ethereal.email') throw new Error('Invalid preview URL');
        return { mode: 'preview', preview_url: parsed.href,
          message: 'Preview only — no email was delivered to your inbox. Open the Ethereal preview to inspect your report.' };
      }
      if (!info.accepted?.some(address => String(address).toLowerCase() === student.email.toLowerCase()) || info.rejected?.length) {
        throw new Error('Recipient not accepted');
      }
      return { mode: 'smtp', message: `Report accepted by the mail server for ${student.email}. Inbox delivery is not guaranteed.` };
    } catch {
      throw new RequestError(502, 'Report email could not be confirmed. Check mail configuration or connectivity before retrying; a mail server may already have accepted it.');
    }
  } };
}

module.exports = { createReportMailer };
