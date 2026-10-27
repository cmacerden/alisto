const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReportMailer } = require('../lib/report-email');

const report = { session: { id: 42, class_title: 'Class <script>', started_at: 1000000, ended_at: 2000000, source: 'meet' },
  completion_label: 'Completed', measurement_label: 'Google Meet', notice: 'Not attention.',
  self: { name: 'Student', email: 'registered@example.com', status: 'Offline', active_seconds: 5400, total_seconds: 7200,
    excluded_seconds: 60, activity_rate: 75, participation: { responded_count: 1, eligible_count: 2, participation_rate: 50, classification: 'Moderately Active' } } };

function mock() {
  const messages = []; const options = []; let accounts = 0;
  return { messages, options, get accounts() { return accounts; },
    async createTestAccount() { accounts++; return { smtp: { host: 'smtp.ethereal.email', port: 587, secure: false }, user: 'test', pass: 'secret' }; },
    createTransport(config) { options.push(config); return { async sendMail(message) { messages.push(message); return { accepted: ['registered@example.com'] }; } }; },
    getTestMessageUrl() { return 'https://ethereal.email/message/test-id'; } };
}

test('SMTP sends plain-text report and CSV only to the registered address using TLS', async () => {
  const mail = mock();
  const mailer = createReportMailer({ env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'Alisto <reports@example.com>', SMTP_USER: 'user', SMTP_PASS: 'secret' }, mail });
  const result = await mailer.send(report, 'csv-body', 'report.csv');
  assert.equal(result.mode, 'smtp'); assert.match(result.message, /accepted by the mail server/i);
  assert.equal(mail.accounts, 0);
  assert.equal(mail.options[0].requireTLS, true);
  assert.equal(mail.messages[0].to.address, 'registered@example.com');
  assert.match(mail.messages[0].text, /1:30:00/);
  assert.match(mail.messages[0].text, /Cannot verify/);
  assert.equal(mail.messages[0].html, undefined);
  assert.equal(mail.messages[0].attachments[0].content, 'csv-body');
  assert.equal(mail.messages[0].disableFileAccess, true);
  assert.equal(mail.messages[0].disableUrlAccess, true);
});

test('no SMTP creates a cached Ethereal account and returns preview-only, never delivery success', async () => {
  const mail = mock(); const mailer = createReportMailer({ env: {}, mail });
  const result = await mailer.send(report, 'csv', 'report.csv');
  assert.equal(result.mode, 'preview');
  assert.match(result.message, /no email was delivered/i);
  assert.equal(result.preview_url, 'https://ethereal.email/message/test-id');
  assert.match(mail.messages[0].text, /PREVIEW ONLY/);
  await mailer.send(report, 'csv', 'report.csv');
  assert.equal(mail.accounts, 1);
});

test('implicit TLS uses the configured SMTP port and empty rates are rendered as N/A', async () => {
  const mail = mock();
  const mailer = createReportMailer({ env: { SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'reports@example.com', SMTP_PORT: '465', SMTP_SECURE: 'true' }, mail });
  const empty = { ...report, self: { ...report.self, activity_rate: null,
    participation: { responded_count: 0, eligible_count: 0, participation_rate: null, classification: 'Not yet applicable' } } };
  await mailer.send(empty, '', 'report.csv');
  assert.equal(mail.options[0].secure, true);
  assert.equal(mail.options[0].port, 465);
  assert.match(mail.messages[0].text, /Activity Rate: N\/A/);
  assert.match(mail.messages[0].text, /Participation Rate: N\/A/);
});

test('partial/invalid SMTP never silently falls back to preview or exposes credentials', async () => {
  for (const env of [{ SMTP_HOST: 'host' }, { SMTP_PORT: '587' },
    { SMTP_HOST: 'host', SMTP_FROM: 'from@example.com', SMTP_PORT: '0' },
    { SMTP_HOST: 'host', SMTP_FROM: 'from@example.com', SMTP_SECURE: 'yes' },
    { SMTP_HOST: 'host', SMTP_FROM: 'from@example.com', SMTP_USER: 'user' }]) {
    const mail = mock(); const mailer = createReportMailer({ env, mail });
    await assert.rejects(mailer.send(report, '', ''), { status: 502 });
    assert.equal(mail.accounts, 0); assert.equal(mail.messages.length, 0);
  }
});

test('SMTP rejection, transport failure, preview failure, and unsafe preview URLs report failure honestly', async () => {
  for (const mode of ['rejected', 'transport', 'account', 'unsafe-preview']) {
    const mail = mock();
    if (mode === 'rejected') mail.createTransport = () => ({ sendMail: async () => ({ accepted: [], rejected: ['registered@example.com'] }) });
    if (mode === 'transport') mail.createTransport = () => ({ sendMail: async () => { throw new Error('smtp secret=password'); } });
    if (mode === 'account') mail.createTestAccount = async () => { throw new Error('account failed'); };
    if (mode === 'unsafe-preview') mail.getTestMessageUrl = () => 'https://evil.example/test';
    const smtp = ['rejected', 'transport'].includes(mode) ? { SMTP_HOST: 'host', SMTP_FROM: 'from@example.com' } : {};
    const mailer = createReportMailer({ env: smtp, mail });
    await assert.rejects(mailer.send(report, '', ''), error => error.status === 502 && !error.message.includes('password'));
  }
});

test('Nodemailer compiles a real MIME report with a UTF-8 CSV attachment without network delivery', async () => {
  const nodemailer = require('nodemailer');
  let mime;
  const mail = { createTransport() {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    return { async sendMail(message) {
      const result = await stream.sendMail(message); mime = result.message.toString();
      return { accepted: ['registered@example.com'] };
    } };
  } };
  const mailer = createReportMailer({ env: { SMTP_HOST: 'unused', SMTP_FROM: 'reports@example.com' }, mail });
  await mailer.send(report, '\uFEFF"Name","Value"\r\n"Student","N/A"\r\n', 'alisto-report.csv');
  assert.match(mime, /To: Student <registered@example.com>/);
  assert.match(mime, /Content-Type: multipart\/mixed/);
  assert.match(mime, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(mime, /Content-Type: text\/csv; charset=utf-8; name=alisto-report.csv/);
  assert.match(mime, /Content-Disposition: attachment; filename=alisto-report.csv/);
  assert.ok(!mime.includes('Content-Type: text/html'));
});
