'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { startFixture, testOptions } = require('./postgres-fixture');

test('registration replacement and delivery failures keep accounts unverified', testOptions, async t => {
  const { origin, messages, db } = await startFixture(t, {
    failRecipients: ['fail@example.test'], env: { ADMIN_EMAIL: '', ADMIN_PASSWORD: '' }
  });
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
    const mail = messages.at(-1);
    return mail.text.match(/\b\d{6}\b/)[0];
  };
  const first = await session();
  const replacement = await session();
  assert.equal((await first('/api/auth/register', 'POST', { name: 'First', email: 'pending@example.test', password: 'first-password-12345' })).body.verificationRequired, true);
  const firstCode = latestCode();
  await db.prepare("UPDATE code_requests SET created_at = ? WHERE purpose = 'registration'").run(Date.now() - 61000);
  assert.equal((await replacement('/api/auth/register', 'POST', { name: 'Second', email: 'pending@example.test', password: 'second-password-12345' })).body.verificationRequired, true);
  assert.equal((await first('/api/auth/verification')).status, 401);
  assert.equal((await first('/api/auth/verification/confirm', 'POST', { code: firstCode })).status, 400);
  assert.equal((await replacement('/api/auth/verification/confirm', 'POST', { code: latestCode() })).body.user.name, 'Second');
  assert.equal((await first('/api/auth/login', 'POST', { email: 'pending@example.test', password: 'first-password-12345' })).status, 401);

  const failed = await session();
  assert.equal((await failed('/api/auth/register', 'POST', { name: 'Failed', email: 'fail@example.test', password: 'failed-password-12345' })).body.verificationRequired, true);
  assert.equal((await failed('/api/auth/verification')).body.deliveryStatus, 'failed');
  assert.equal((await failed('/api/orders')).status, 401);
  await db.prepare("UPDATE code_requests SET created_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?) AND purpose = 'registration'").run(Date.now() - 61000, 'fail@example.test');
  assert.equal((await failed('/api/auth/verification/resend', 'POST', {})).status, 503);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM account_codes WHERE user_id = (SELECT id FROM users WHERE email = ?)").get('fail@example.test')).count, 0);
});
