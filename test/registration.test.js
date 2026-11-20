'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const Database = require('better-sqlite3');

test('registration replacement and delivery failures keep accounts unverified', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'torquex-register-'));
  const databasePath = path.join(directory, 'registration.sqlite');
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
      SESSION_SECRET: 'test-session-secret-at-least-32-characters', ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
      SMTP_HOST: 'mock', SMTP_USER: 'test', SMTP_PASSWORD: 'test', SMTP_FROM: 'store@example.test',
      GOURL_PUBLIC_KEY: '', GOURL_PRIVATE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  let db;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (db?.open) db.close();
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
  const latestCode = () => {
    const mail = fs.readFileSync(mailLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)).at(-1);
    return mail.text.match(/\b\d{6}\b/)[0];
  };
  const first = await session();
  const replacement = await session();
  assert.equal((await first('/api/auth/register', 'POST', { name: 'First', email: 'pending@example.test', password: 'first-password-12345' })).body.verificationRequired, true);
  const firstCode = latestCode();
  db = new Database(databasePath);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'registration'").run(Date.now() - 61000);
  assert.equal((await replacement('/api/auth/register', 'POST', { name: 'Second', email: 'pending@example.test', password: 'second-password-12345' })).body.verificationRequired, true);
  assert.equal((await first('/api/auth/verification')).status, 401);
  assert.equal((await first('/api/auth/verification/confirm', 'POST', { code: firstCode })).status, 400);
  assert.equal((await replacement('/api/auth/verification/confirm', 'POST', { code: latestCode() })).body.user.name, 'Second');
  assert.equal((await first('/api/auth/login', 'POST', { email: 'pending@example.test', password: 'first-password-12345' })).status, 401);

  const failed = await session();
  assert.equal((await failed('/api/auth/register', 'POST', { name: 'Failed', email: 'fail@example.test', password: 'failed-password-12345' })).body.verificationRequired, true);
  assert.equal((await failed('/api/auth/verification')).body.deliveryStatus, 'failed');
  assert.equal((await failed('/api/orders')).status, 401);
  db.prepare("UPDATE code_requests SET created_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND purpose = 'registration'").run(Date.now() - 61000, 'fail@example.test');
  assert.equal((await failed('/api/auth/verification/resend', 'POST', {})).status, 503);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_codes WHERE user_id = (SELECT id FROM users WHERE email = ?)").get('fail@example.test').count, 0);
});
