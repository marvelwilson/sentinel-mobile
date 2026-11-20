'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const Database = require('better-sqlite3');
const { renderEmail } = require('../email-templates');

test('account verification, session invalidation, contact receipts and email previews', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'torquex-account-'));
  const databasePath = path.join(directory, 'account.sqlite');
  const mailLog = path.join(directory, 'mail.jsonl');
  const preload = path.join(directory, 'mock-mail.js');
  const port = 32000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(preload, `const mailer = require(${JSON.stringify(require.resolve('nodemailer'))});
    mailer.createTransport = () => ({ sendMail: async message => {
      if (message.to === 'fail@example.test') throw new Error('Simulated mail failure');
      require('node:fs').appendFileSync(${JSON.stringify(mailLog)}, JSON.stringify(message) + '\\n');
      return { accepted: [message.to] };
    } });`);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_PATH: databasePath,
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-password-12345',
      SMTP_HOST: 'mock', SMTP_USER: 'test', SMTP_PASSWORD: 'test', SMTP_FROM: 'store@example.test',
      PUBLIC_BASE_URL: 'https://cars.example.test', GOURL_PUBLIC_KEY: '', GOURL_PRIVATE_KEY: '', GOURL_COIN: 'bitcoin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill();
      await exited;
      clearTimeout(forceStop);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await delay(250);
  }
  assert.ok(ready, `Server failed to start: ${output}`);
  async function session() {
    let cookie = '', token = '';
    const send = async (url, method = 'GET', body) => {
      const response = await fetch(origin + url, { method, headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json', 'x-csrf-token': token } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const cookies = response.headers.getSetCookie?.() || [];
      if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
      const data = await response.json();
      if (data.token) token = data.token;
      return { status: response.status, body: data };
    };
    await send('/api/csrf');
    return send;
  }
  const buyer = await session();
  const admin = await session();
  const other = await session();
  const mails = () => fs.existsSync(mailLog) ? fs.readFileSync(mailLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const latestCode = (subject, to) => {
    const mail = mails().filter(item => item.subject === subject && item.to === to).at(-1);
    assert.ok(mail, `Missing ${subject} for ${to}`);
    const match = mail.text.match(/\b\d{6}\b/);
    assert.ok(match);
    return match[0];
  };
  assert.equal((await admin('/api/auth/login', 'POST', { email: 'admin@example.test', password: 'admin-password-12345' })).status, 200);
  const registration = await buyer('/api/auth/register', 'POST', { name: 'Buyer', email: 'buyer@example.test', password: 'buyer-password-12345' });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.verificationRequired, true);
  assert.equal((await buyer('/api/orders')).status, 401);
  const unverifiedLogin = await other('/api/auth/login', 'POST', { email: 'buyer@example.test', password: 'buyer-password-12345' });
  assert.equal(unverifiedLogin.body.verificationRequired, true);
  assert.equal((await other('/api/orders')).status, 401);
  assert.equal((await buyer('/api/auth/verification')).body.deliveryStatus, 'sent');
  let registrationCode = latestCode('Verify your TorqueX account', 'buyer@example.test');
  const db = new Database(databasePath);
  assert.notEqual(db.prepare("SELECT code_hash FROM account_codes WHERE purpose = 'registration'").get().code_hash, registrationCode);
  const wrongRegistrationCode = registrationCode === '000000' ? '000001' : '000000';
  assert.equal((await buyer('/api/auth/verification/confirm', 'POST', { code: wrongRegistrationCode })).status, 400);
  db.prepare("UPDATE account_codes SET expires_at = '2020-01-01' WHERE purpose = 'registration'").run();
  assert.equal((await buyer('/api/auth/verification/confirm', 'POST', { code: registrationCode })).status, 400);
  assert.equal((await buyer('/api/auth/verification/resend', 'POST', {})).status, 429);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'registration'").run(Date.now() - 61000);
  assert.equal((await buyer('/api/auth/verification/resend', 'POST', {})).status, 200);
  registrationCode = latestCode('Verify your TorqueX account', 'buyer@example.test');
  assert.equal((await buyer('/api/auth/verification/confirm', 'POST', { code: registrationCode })).body.user.email, 'buyer@example.test');
  assert.equal((await other('/api/auth/verification/confirm', 'POST', { code: registrationCode })).status, 400);
  assert.equal((await other('/api/auth/login', 'POST', { email: 'buyer@example.test', password: 'buyer-password-12345' })).status, 200);
  assert.equal((await buyer('/api/account/profile', 'PATCH', { name: 'New Name' })).body.user.name, 'New Name');
  assert.equal((await other('/api/me')).body.user.name, 'New Name');
  assert.equal((await buyer('/api/account/password', 'POST', { currentPassword: 'wrong', newPassword: 'new-password-12345', confirmPassword: 'new-password-12345' })).status, 400);
  assert.equal((await buyer('/api/account/password', 'POST', { currentPassword: 'buyer-password-12345', newPassword: 'new-password-12345', confirmPassword: 'different-password' })).status, 400);
  assert.equal((await buyer('/api/account/password', 'POST', { currentPassword: 'buyer-password-12345', newPassword: 'new-password-12345', confirmPassword: 'new-password-12345' })).status, 200);
  assert.equal((await other('/api/me')).body.user, null);
  assert.equal((await other('/api/orders')).status, 401);
  assert.equal((await buyer('/api/me')).body.user.name, 'New Name');

  const resetBody = { email: 'buyer@example.test' };
  const unknown = await other('/api/auth/password-reset/request', 'POST', { email: 'unknown@example.test' });
  const requested = await other('/api/auth/password-reset/request', 'POST', resetBody);
  assert.deepEqual(requested.body, unknown.body);
  for (let i = 0; i < 50 && !mails().some(item => item.subject === 'Your TorqueX password reset code'); i++) await delay(20);
  let resetCode = latestCode('Your TorqueX password reset code', 'buyer@example.test');
  const stored = db.prepare("SELECT code_hash FROM account_codes WHERE purpose = 'reset'").get();
  assert.notEqual(stored.code_hash, resetCode);
  assert.ok(!JSON.stringify(stored).includes(resetCode));
  db.prepare("UPDATE account_codes SET expires_at = '2020-01-01' WHERE purpose = 'reset'").run();
  const resetConfirm = code => other('/api/auth/password-reset/confirm', 'POST', {
    ...resetBody, code, newPassword: 'reset-password-12345', confirmPassword: 'reset-password-12345'
  });
  assert.equal((await resetConfirm(resetCode)).status, 400);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'reset'").run(Date.now() - 61000);
  await other('/api/auth/password-reset/request', 'POST', resetBody);
  for (let i = 0; i < 50 && mails().filter(item => item.subject === 'Your TorqueX password reset code').length < 2; i++) await delay(20);
  resetCode = latestCode('Your TorqueX password reset code', 'buyer@example.test');
  const wrongCode = resetCode === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await resetConfirm(wrongCode)).status, 400);
  assert.equal((await resetConfirm(resetCode)).status, 400);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'reset'").run(Date.now() - 61000);
  await other('/api/auth/password-reset/request', 'POST', resetBody);
  for (let i = 0; i < 50 && mails().filter(item => item.subject === 'Your TorqueX password reset code').length < 3; i++) await delay(20);
  resetCode = latestCode('Your TorqueX password reset code', 'buyer@example.test');
  assert.equal((await resetConfirm(resetCode)).status, 200);
  assert.equal((await resetConfirm(resetCode)).status, 400);
  assert.equal((await buyer('/api/me')).body.user, null);
  assert.equal((await buyer('/api/auth/login', 'POST', { email: 'buyer@example.test', password: 'reset-password-12345' })).status, 200);
  assert.equal((await other('/api/auth/login', 'POST', { email: 'buyer@example.test', password: 'reset-password-12345' })).status, 200);
  assert.equal((await buyer('/api/account/email/request', 'POST', { newEmail: 'new@example.test', currentPassword: 'wrong' })).status, 400);
  assert.equal((await buyer('/api/account/email/request', 'POST', { newEmail: 'new@example.test', currentPassword: 'reset-password-12345' })).status, 200);
  const oldCode = latestCode('Your TorqueX email verification code', 'buyer@example.test');
  assert.equal((await buyer('/api/account/email/verify-new', 'POST', { code: oldCode })).status, 400);
  assert.equal((await buyer('/api/account/email/verify-old', 'POST', { code: oldCode })).status, 200);
  const newCode = latestCode('Your TorqueX email verification code', 'new@example.test');
  assert.equal((await buyer('/api/account/email/verify-new', 'POST', { code: newCode })).body.user.email, 'new@example.test');
  assert.equal((await other('/api/me')).body.user, null);
  assert.equal((await buyer('/api/account/email/verify-new', 'POST', { code: newCode })).status, 400);
  assert.equal((await other('/api/auth/login', 'POST', { email: 'buyer@example.test', password: 'reset-password-12345' })).status, 401);
  assert.equal((await other('/api/auth/login', 'POST', { email: 'new@example.test', password: 'reset-password-12345' })).status, 200);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'email'").run(Date.now() - 61000);
  assert.equal((await buyer('/api/account/email/request', 'POST', { newEmail: 'fail@example.test', currentPassword: 'reset-password-12345' })).status, 200);
  const secondOldCode = latestCode('Your TorqueX email verification code', 'new@example.test');
  assert.equal((await buyer('/api/account/email/verify-old', 'POST', { code: secondOldCode })).status, 503);
  assert.equal((await buyer('/api/me')).body.user.email, 'new@example.test');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_codes WHERE purpose = 'email'").get().count, 0);

  db.close();

  const message = { name: 'Test Buyer', phone: '+12025550123', subject: 'General question', message: 'Hello there' };
  assert.equal((await buyer('/api/contact-messages', 'POST', { ...message, email: 'new@example.test' })).body.confirmationStatus, 'sent');
  assert.equal((await buyer('/api/contact-messages', 'POST', { ...message, email: 'fail@example.test' })).body.confirmationStatus, 'failed');
  const contactMail = mails().find(item => item.subject === 'We received your message | TorqueX');
  assert.match(contactMail.html, /Thank you for reaching out/);
  const contactMessages = (await admin('/api/admin/contact-messages')).body.messages;
  assert.equal(contactMessages.find(item => item.email === 'fail@example.test').confirmation_status, 'failed');
  assert.equal((await buyer('/api/admin/email-previews')).status, 403);
  const previews = (await admin('/api/admin/email-previews')).body.templates;
  assert.equal(previews.length, 8);
  for (const template of previews) {
    const result = await admin(`/api/admin/email-previews/${template.id}`);
    assert.equal(result.status, 200);
    assert.match(result.body.html, /TORQUE/);
    assert.ok(result.body.text);
  }
  const escaped = renderEmail('contact_received', { name: '<img src=x onerror=alert(1)>', inquiry: 'Question' });
  assert.ok(!escaped.html.includes('<img src=x'));
  assert.ok(escaped.html.includes('&lt;img'));
});
