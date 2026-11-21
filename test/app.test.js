'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const demoPublicKey = '25654AAo79c3Bitcoin77BTCPUBqwIefT1j9fqqMwUtMI0huVL';
const demoPrivateKey = '25654AAo79c3Bitcoin77BTCPRV0JG7w3jg0Tc5Pfi34U8o5JE';

test('admin-managed inventory can be reserved and confirmed through GoUrl IPN', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'torquex-test-'));
  const port = 32000 + Math.floor(Math.random() * 20000);
  const databasePath = path.join(directory, 'torquex.sqlite');
  const previous = new Database(databasePath);
  previous.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('legacy-user', 'Legacy Buyer', 'legacy@example.test', 'unused', 'customer', '2020-01-01T00:00:00.000Z');
    CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
      payment_method TEXT NOT NULL, currency TEXT NOT NULL, subtotal_usd REAL NOT NULL, discount_usd REAL NOT NULL DEFAULT 0,
      total_usd REAL NOT NULL, promo_code TEXT, buyer_details TEXT NOT NULL, payment_details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO orders VALUES ('legacy-order', 'legacy-user', 'cancelled', 'bank', 'USD', 100, 0, 100, NULL, '{}', '{}',
      '2020-01-01T00:00:00.000Z', '2020-01-01T01:00:00.000Z');
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('bank_details', '{"bankName":"Old Bank","accountName":"Old Owner","accountNumber":"123"}');
  `);
  previous.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('legacy-password-12345', 12), 'legacy-user');
  previous.close();
  const preload = path.join(directory, 'mock-rates.js');
  const mailLog = path.join(directory, 'emails.jsonl');
  fs.writeFileSync(preload, `const originalFetch = global.fetch;
    global.fetch = (url, options) => String(url) === 'https://open.er-api.com/v6/latest/USD'
      ? Promise.resolve(new Response(JSON.stringify({ result: 'success', rates: { USD: 1, EUR: 0.9, JPY: 150 }, time_last_update_utc: '2026-01-01T00:00:00Z' }), { status: 200 }))
      : originalFetch(url, options);
    const mailer = require(${JSON.stringify(require.resolve('nodemailer'))});
    mailer.createTransport = () => ({ sendMail: async message => {
      if (message.to === 'marvelwilsononit@gmail.com' || message.to === 'fail@example.test') throw new Error('Simulated mail failure');
      require('node:fs').appendFileSync(${JSON.stringify(mailLog)}, JSON.stringify(message) + '\\n');
      return { accepted: [message.to] };
    } });`);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'admin-password-12345',
      GOURL_PUBLIC_KEY: demoPublicKey,
      GOURL_PRIVATE_KEY: demoPrivateKey,
      GOURL_COIN: 'bitcoin',
      SMTP_HOST: 'mock', SMTP_USER: 'test', SMTP_PASSWORD: 'test', SMTP_FROM: 'store@example.test',
      PUBLIC_BASE_URL: 'https://cars.example.test'
    },
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
    try {
      const response = await fetch(origin);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await delay(250);
  }
  assert.equal(ready, true, `server did not start:\n${output}`);

  const csrfRejected = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No Token', email: 'no-token@example.test', password: 'no-token-password-123' })
  });
  assert.equal(csrfRejected.status, 403);

  async function createSession(email, password, name) {
    let cookie = '';
    const send = async (url, options = {}) => {
      const headers = { ...(options.headers || {}) };
      if (cookie) headers.cookie = cookie;
      const response = await fetch(`${origin}${url}`, { ...options, headers });
      const setCookies = response.headers.getSetCookie?.() || [];
      if (setCookies.length) cookie = setCookies.map(value => value.split(';')[0]).join('; ');
      const body = await response.json();
      return { response, body };
    };
    const csrf = await send('/api/csrf');
    let token = csrf.body.token;
    const login = await send('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ email, password })
    });
    if (login.response.ok) token = login.body.token;
    else if (name) {
      const register = await send('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ name, email, password })
      });
      assert.equal(register.response.status, 200, JSON.stringify(register.body));
      token = register.body.token;
      const mail = fs.readFileSync(mailLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(message => message.to === email && message.subject === 'Verify your TurqueX account').at(-1);
      const verify = await send('/api/auth/verification/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ code: mail.text.match(/\b\d{6}\b/)[0] })
      });
      assert.equal(verify.response.status, 200, JSON.stringify(verify.body));
      token = verify.body.token;
      return { send, cookie, token };
    }
    assert.equal(login.response.status, 200, JSON.stringify(login.body));
    return { send, cookie, token };
  }

  const admin = await createSession('admin@example.test', 'admin-password-12345');
  const legacySession = await createSession('legacy@example.test', 'legacy-password-12345');
  assert.equal((await legacySession.send('/api/me')).body.user.email, 'legacy@example.test');
  const migratedBanks = await admin.send('/api/admin/banks');
  assert.equal(migratedBanks.body.banks[0].bankName, 'Old Bank');
  assert.equal(migratedBanks.body.banks[0].currency, null);
  const legacyOrder = (await admin.send('/api/admin/orders')).body.orders.find(order => order.id === 'legacy-order');
  assert.match(legacyOrder.tracking.code, /^TX-[A-F0-9]{32}$/);
  assert.equal(legacyOrder.tracking.emailStatus, null);
  const carResponse = await admin.send('/api/admin/cars', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': admin.token },
    body: JSON.stringify({
      make: 'Test Motor', model: 'Roadster', year: 2025, priceUsd: 1000,
      mileage: 10, transmission: 'Manual', bodyType: 'Coupe',
      description: 'Integration test listing', imageUrl: '/assets/img/project/1.jpg'
    })
  });
  assert.equal(carResponse.response.status, 201, JSON.stringify(carResponse.body));
  const carId = carResponse.body.car.id;

  const promoResponse = await admin.send('/api/admin/promos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': admin.token },
    body: JSON.stringify({ code: 'TEST10', kind: 'percent', amount: 10 })
  });
  assert.equal(promoResponse.response.status, 201, JSON.stringify(promoResponse.body));

  const bankSettings = await admin.send('/api/admin/settings/bank', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-csrf-token': admin.token },
    body: JSON.stringify({ accountName: 'Test Dealership', bankName: 'Test Bank', accountNumber: '00000000' })
  });
  assert.equal(bankSettings.response.status, 200);
  const publicSettings = await admin.send('/api/payment-settings');
  assert.equal(publicSettings.body.bankTransferEnabled, true);
  assert.equal(Object.hasOwn(publicSettings.body, 'bankDetails'), false);

  const customer = await createSession('buyer@example.test', 'buyer-password-12345', 'Test Buyer');
  const jsonHeaders = session => ({ 'content-type': 'application/json', 'x-csrf-token': session.token });
  const missingCsrf = await fetch(`${origin}/api/contact-messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(missingCsrf.status, 403);
  const invalidMessage = await customer.send('/api/contact-messages', {
    method: 'POST', headers: jsonHeaders(customer),
    body: JSON.stringify({ name: 'Buyer', email: 'invalid', phone: '+12025550123', subject: 'General question', message: 'Hello there' })
  });
  assert.equal(invalidMessage.response.status, 400);
  const contactMessage = await customer.send('/api/contact-messages', {
    method: 'POST', headers: jsonHeaders(customer),
    body: JSON.stringify({ name: 'Buyer', email: 'buyer@example.test', phone: '+12025550123', subject: 'Vehicle inquiry', message: 'Tell me more about this car.' })
  });
  assert.equal(contactMessage.response.status, 201);
  assert.equal(contactMessage.body.confirmationStatus, 'sent');
  assert.equal((await customer.send('/api/admin/contact-messages')).response.status, 403);
  const messages = await admin.send('/api/admin/contact-messages');
  assert.equal(messages.body.messages[0].message, 'Tell me more about this car.');
  assert.equal(messages.body.messages[0].confirmation_status, 'sent');
  const messageUpdate = await admin.send(`/api/admin/contact-messages/${messages.body.messages[0].id}`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'handled' })
  });
  assert.equal(messageUpdate.response.status, 200);

  const invalidContact = await admin.send('/api/admin/settings/contact', {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ phone: 'yes' })
  });
  assert.equal(invalidContact.response.status, 400);
  const savedContact = await admin.send('/api/admin/settings/contact', {
    method: 'PUT', headers: jsonHeaders(admin),
    body: JSON.stringify({ phone: '+12025550123', address: 'Test address', hours: 'By appointment' })
  });
  assert.equal(savedContact.response.status, 200);
  assert.equal((await customer.send('/api/contact-details')).body.contact.phone, '+12025550123');
  assert.equal((await fetch(`${origin}/contact.html`, { redirect: 'manual' })).headers.get('location'), '/contact');
  assert.equal((await fetch(`${origin}/book-call`)).status, 200);

  const callDetails = {
    name: 'Buyer', email: 'buyer@example.test', phone: '+12025550123',
    preferredAt: new Date(Date.now() + 86400000).toISOString(), timezone: 'America/New_York', notes: 'Interested in the Roadster'
  };
  const invalidCall = await customer.send('/api/call-requests', {
    method: 'POST', headers: jsonHeaders(customer), body: JSON.stringify({ ...callDetails, preferredAt: '2020-01-01T00:00:00Z' })
  });
  assert.equal(invalidCall.response.status, 400);
  const invalidTimezone = await customer.send('/api/call-requests', {
    method: 'POST', headers: jsonHeaders(customer), body: JSON.stringify({ ...callDetails, timezone: 'Not/A_Timezone' })
  });
  assert.equal(invalidTimezone.response.status, 400);
  const ambiguousTime = await customer.send('/api/call-requests', {
    method: 'POST', headers: jsonHeaders(customer), body: JSON.stringify({ ...callDetails, preferredAt: callDetails.preferredAt.slice(0, 19) })
  });
  assert.equal(ambiguousTime.response.status, 400);
  const call = await customer.send('/api/call-requests', {
    method: 'POST', headers: jsonHeaders(customer), body: JSON.stringify(callDetails)
  });
  assert.equal(call.response.status, 201);
  assert.equal(call.body.status, 'requested');
  const callUrl = `/api/call-requests/${call.body.id}`;
  assert.equal((await customer.send(callUrl)).response.status, 404);
  assert.equal((await customer.send(callUrl, { headers: { 'x-request-token': 'a'.repeat(64) } })).response.status, 404);
  const pendingCall = await customer.send(callUrl, { headers: { 'x-request-token': call.body.trackingToken } });
  assert.equal(pendingCall.body.status, 'requested');
  assert.equal(pendingCall.body.preferredAt, callDetails.preferredAt);
  assert.equal(Object.hasOwn(pendingCall.body, 'phone'), false);
  const calls = await admin.send('/api/admin/call-requests');
  assert.equal(calls.body.requests[0].timezone, 'America/New_York');
  assert.equal(Object.hasOwn(calls.body.requests[0], 'token_hash'), false);
  const forbiddenUpdate = await customer.send(`/api/admin/call-requests/${call.body.id}`, {
    method: 'PATCH', headers: jsonHeaders(customer), body: JSON.stringify({ status: 'confirmed' })
  });
  assert.equal(forbiddenUpdate.response.status, 403);
  const callUpdate = await admin.send(`/api/admin/call-requests/${call.body.id}`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'confirmed' })
  });
  assert.equal(callUpdate.response.status, 200);
  const confirmedCall = await customer.send(callUrl, { headers: { 'x-request-token': call.body.trackingToken } });
  assert.equal(confirmedCall.body.status, 'confirmed');

  const bankCar = await admin.send('/api/admin/cars', {
    method: 'POST', headers: jsonHeaders(admin),
    body: JSON.stringify({ make: 'Bank Test', model: 'Coupe', year: 2025, priceUsd: 2000, mileage: 10, transmission: 'Manual', bodyType: 'Coupe' })
  });
  assert.equal(bankCar.response.status, 201);
  const bank = await admin.send('/api/admin/banks', {
    method: 'POST', headers: jsonHeaders(admin),
    body: JSON.stringify({ bankName: 'Euro Bank', accountName: 'Test Owner', accountNumber: '12345678', currency: 'EUR' })
  });
  assert.equal(bank.response.status, 201);
  const bankOrder = await customer.send('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': customer.token },
    body: JSON.stringify({
      carIds: [bankCar.body.car.id],
      paymentMethod: 'bank',
      currency: 'USD',
      buyer: {
        name: 'Test Buyer',
        email: 'buyer@example.test',
        phone: '+1 555 0100',
        address: '1 Test Street',
        city: 'Austin',
        country: 'US'
      }
    })
  });
  assert.equal(bankOrder.response.status, 201, JSON.stringify(bankOrder.body));
  assert.equal(bankOrder.body.order.status, 'awaiting_bank_assignment');
  assert.equal(bankOrder.body.order.expiresAt, null);
  const bankOrderId = bankOrder.body.order.id;
  const bankTrackingCode = bankOrder.body.order.tracking.code;
  assert.match(bankTrackingCode, /^TX-[A-F0-9]{32}$/);
  assert.equal(bankOrder.body.order.tracking.emailStatus, 'sent');
  const trackingMail = fs.readFileSync(mailLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .find(message => message.subject === 'Your TurqueX tracking link');
  assert.equal(trackingMail.to, 'buyer@example.test');
  assert.ok(trackingMail.text.includes(`https://cars.example.test/track#${bankTrackingCode}`));
  assert.equal((await customer.send('/api/tracking')).response.status, 404);
  assert.equal((await customer.send('/api/tracking', { headers: { 'x-tracking-code': `TX-${'F'.repeat(32)}` } })).response.status, 404);
  const tracking = await customer.send('/api/tracking', { headers: { 'x-tracking-code': bankTrackingCode } });
  assert.equal(tracking.body.status, 'order_received');
  assert.deepEqual(tracking.body.events, []);
  assert.equal(Object.hasOwn(tracking.body, 'buyer'), false);
  assert.equal(Object.hasOwn(tracking.body, 'paymentDetails'), false);
  assert.equal(JSON.stringify(tracking.body).includes(bankOrderId), false);
  const unauthorizedShipment = await customer.send(`/api/admin/orders/${bankOrderId}/shipment`, {
    method: 'PATCH', headers: jsonHeaders(customer), body: JSON.stringify({ status: 'in_transit' })
  });
  assert.equal(unauthorizedShipment.response.status, 403);
  const prematureShipment = await admin.send(`/api/admin/orders/${bankOrderId}/shipment`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'in_transit' })
  });
  assert.equal(prematureShipment.response.status, 409);
  assert.equal((await admin.send('/api/admin/orders')).body.orders.find(item => item.id === bankOrderId).notificationStatus, 'failed');
  assert.equal((await customer.send(`/api/cars/${bankCar.body.car.id}`)).body.car.status, 'reserved');
  const oldPending = new Database(databasePath);
  oldPending.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', bankOrderId);
  oldPending.close();
  assert.equal((await customer.send(`/api/orders/${bankOrderId}`)).body.order.status, 'awaiting_bank_assignment');
  const other = await createSession('other@example.test', 'other-password-12345', 'Other Buyer');
  const forbiddenClaim = await other.send(`/api/orders/${bankOrderId}/payment-claim`, {
    method: 'POST', headers: jsonHeaders(other), body: '{}'
  });
  assert.equal(forbiddenClaim.response.status, 404);
  const noCurrency = await admin.send(`/api/admin/orders/${bankOrderId}/assign-bank`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify({ bankId: 'legacy-bank-account' })
  });
  assert.equal(noCurrency.response.status, 400);
  const unsupportedBank = await admin.send('/api/admin/banks', {
    method: 'POST', headers: jsonHeaders(admin),
    body: JSON.stringify({ bankName: 'Unsupported Bank', accountName: 'Test Owner', accountNumber: '123', currency: 'ZZZ' })
  });
  const unsupportedAssignment = await admin.send(`/api/admin/orders/${bankOrderId}/assign-bank`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify({ bankId: unsupportedBank.body.bank.id })
  });
  assert.equal(unsupportedAssignment.response.status, 400);
  assert.equal((await customer.send(`/api/orders/${bankOrderId}`)).body.order.expiresAt, null);
  const assignment = await admin.send(`/api/admin/orders/${bankOrderId}/assign-bank`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify({ bankId: bank.body.bank.id })
  });
  assert.equal(assignment.response.status, 200, JSON.stringify(assignment.body));
  assert.equal(assignment.body.paymentDetails.amount, 1800);
  assert.equal(assignment.body.paymentDetails.rate, 0.9);
  assert.ok(new Date(assignment.body.expiresAt).getTime() - Date.now() > 59 * 60 * 1000);
  const assignedOrder = await customer.send(`/api/orders/${bankOrderId}`);
  assert.equal(assignedOrder.body.order.paymentDetails.bankDetails.accountNumber, '12345678');
  assert.equal((await other.send(`/api/orders/${bankOrderId}`)).response.status, 404);
  const bankChanged = await admin.send(`/api/admin/banks/${bank.body.bank.id}`, {
    method: 'PUT', headers: jsonHeaders(admin),
    body: JSON.stringify({ bankName: 'Updated Bank', accountName: 'Test Owner', accountNumber: '9999', currency: 'EUR' })
  });
  assert.equal(bankChanged.response.status, 200);
  assert.equal((await customer.send(`/api/orders/${bankOrderId}`)).body.order.paymentDetails.bankDetails.accountNumber, '12345678');
  assert.equal((await admin.send(`/api/admin/orders/${bankOrderId}/assign-bank`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify({ bankId: bank.body.bank.id })
  })).response.status, 409);

  const claim = await customer.send(`/api/orders/${bankOrderId}/payment-claim`, {
    method: 'POST', headers: jsonHeaders(customer), body: '{}'
  });
  assert.equal(claim.response.status, 200);
  assert.ok(new Date(claim.body.proofAvailableAt).getTime() - Date.now() > 59000);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const proofHeaders = { 'content-type': 'application/octet-stream', 'x-proof-type': 'image/png', 'x-csrf-token': customer.token };
  const earlyProof = await customer.send(`/api/orders/${bankOrderId}/payment-proof`, {
    method: 'POST', headers: proofHeaders, body: png
  });
  assert.equal(earlyProof.response.status, 409);
  const db = new Database(databasePath);
  db.prepare('UPDATE payment_proofs SET available_at = ? WHERE order_id = ?').run('2020-01-01T00:00:00.000Z', bankOrderId);
  db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', bankOrderId);
  db.close();
  assert.equal((await customer.send(`/api/cars/${bankCar.body.car.id}`)).body.car.status, 'reserved');
  const invalidProof = await customer.send(`/api/orders/${bankOrderId}/payment-proof`, {
    method: 'POST', headers: proofHeaders, body: Buffer.from('not a PNG')
  });
  assert.equal(invalidProof.response.status, 400);
  const tooLarge = await customer.send(`/api/orders/${bankOrderId}/payment-proof`, {
    method: 'POST', headers: proofHeaders, body: Buffer.alloc(5 * 1024 * 1024 + 1)
  });
  assert.equal(tooLarge.response.status, 413);
  const validProof = await customer.send(`/api/orders/${bankOrderId}/payment-proof`, {
    method: 'POST', headers: proofHeaders, body: png
  });
  assert.equal(validProof.response.status, 201);
  assert.equal((await customer.send(`/api/orders/${bankOrderId}`)).body.order.status, 'proof_submitted');
  assert.equal((await customer.send(`/api/admin/orders/${bankOrderId}/payment-proof`)).response.status, 403);
  const download = await fetch(`${origin}/api/admin/orders/${bankOrderId}/payment-proof`, { headers: { cookie: admin.cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);

  const orderResponse = await customer.send('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': customer.token },
    body: JSON.stringify({
      carIds: [carId],
      paymentMethod: 'gourl',
      currency: 'EUR',
      promoCode: 'test10',
      buyer: {
        name: 'Test Buyer',
        email: 'fail@example.test',
        phone: '+1 555 0100',
        address: '1 Test Street',
        city: 'Austin',
        country: 'US'
      }
    })
  });
  assert.equal(orderResponse.response.status, 201, JSON.stringify(orderResponse.body));
  const { order, cryptoBox } = orderResponse.body;
  assert.equal(order.totalUsd, 900);
  assert.equal(order.status, 'awaiting_payment');
  assert.notEqual(order.tracking.code, bankTrackingCode);
  assert.equal(order.tracking.emailStatus, 'failed');
  assert.equal(Math.round((new Date(order.expiresAt) - new Date(order.createdAt)) / 60000), 60);
  assert.equal(cryptoBox.orderId, order.id);
  assert.equal(cryptoBox.amountUsd, '900');
  assert.equal(cryptoBox.coinName, 'Bitcoin');
  const version = Buffer.from(cryptoBox.version, 'base64').toString('utf8');
  assert.ok(version);
  const expectedHash = crypto.createHash('md5').update([
    cryptoBox.boxId, cryptoBox.coinName, cryptoBox.publicKey, demoPrivateKey, cryptoBox.webdevKey,
    cryptoBox.amount, cryptoBox.amountUsd, cryptoBox.period, cryptoBox.language, cryptoBox.orderId,
    cryptoBox.userId, cryptoBox.userFormat, version, cryptoBox.iframeId, cryptoBox.width, cryptoBox.height
  ].join('|')).digest('hex');
  assert.equal(cryptoBox.hash, expectedHash);

  const callbackProbe = await fetch(`${origin}/api/gourl/ipn`);
  assert.equal(callbackProbe.status, 200);
  assert.match(callbackProbe.headers.get('content-type'), /^text\/plain/);
  assert.equal(await callbackProbe.text(), 'Only POST Data Allowed');
  const invalidCallback = await fetch(`${origin}/api/gourl/ipn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status: 'payment_received' })
  });
  assert.equal(invalidCallback.status, 403);

  const callbackBody = new URLSearchParams({
    private_key_hash: crypto.createHash('sha512').update(demoPrivateKey).digest('hex'),
    status: 'payment_received',
    order: order.id,
    user: cryptoBox.userId,
    confirmed: '0'
  });
  const unrecognized = await fetch(`${origin}/api/gourl/ipn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(callbackBody), status: 'payment_received_unrecognised' })
  });
  assert.equal(await unrecognized.text(), 'cryptobox_nochanges');

  const callback = await fetch(`${origin}/api/gourl/ipn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: callbackBody
  });
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), 'cryptobox_updated');
  const unconfirmedOrder = await customer.send('/api/orders');
  assert.equal(unconfirmedOrder.body.orders.find(item => item.id === order.id).status, 'payment_received');

  const confirmedCallback = await fetch(`${origin}/api/gourl/ipn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(callbackBody), confirmed: '1' })
  });
  assert.equal(await confirmedCallback.text(), 'cryptobox_updated');

  const customerOrders = await customer.send('/api/orders');
  assert.equal(customerOrders.body.orders.find(item => item.id === order.id).status, 'paid');
  const adminSummary = await admin.send('/api/admin/summary');
  assert.equal(adminSummary.body.counts.cars_sold, 1);
  assert.equal(adminSummary.body.counts.paid_orders, 1);
  assert.equal(adminSummary.body.counts.revenue_usd, 900);
  const manualPaid = await admin.send(`/api/admin/orders/${bankOrderId}/status`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'paid' })
  });
  assert.equal(manualPaid.response.status, 200);
  assert.equal((await customer.send(`/api/orders/${bankOrderId}`)).body.order.status, 'paid');
  assert.equal((await customer.send(`/api/cars/${bankCar.body.car.id}`)).response.status, 404);
  const pendingShipment = await customer.send('/api/tracking', { headers: { 'x-tracking-code': bankTrackingCode } });
  assert.equal(pendingShipment.body.status, 'awaiting_shipment');
  const stages = ['preparing', 'in_transit', 'out_for_delivery', 'delivered'];
  for (const stage of stages) {
    const update = await admin.send(`/api/admin/orders/${bankOrderId}/shipment`, {
      method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: stage })
    });
    assert.equal(update.response.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.emailStatus, 'sent');
    assert.equal((await customer.send('/api/tracking', { headers: { 'x-tracking-code': bankTrackingCode } })).body.status, stage);
  }
  const delivered = await customer.send('/api/tracking', { headers: { 'x-tracking-code': bankTrackingCode } });
  assert.deepEqual(delivered.body.events.map(event => event.status), stages);
  const duplicate = await admin.send(`/api/admin/orders/${bankOrderId}/shipment`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'delivered' })
  });
  assert.equal(duplicate.response.status, 409);
  const correction = await admin.send(`/api/admin/orders/${bankOrderId}/shipment`, {
    method: 'PATCH', headers: jsonHeaders(admin), body: JSON.stringify({ status: 'in_transit' })
  });
  assert.equal(correction.response.status, 200);
  const corrected = await customer.send('/api/tracking', { headers: { 'x-tracking-code': bankTrackingCode } });
  assert.equal(corrected.body.status, 'in_transit');
  assert.deepEqual(corrected.body.events.map(event => event.status), [...stages, 'in_transit']);
  const messagesSent = fs.readFileSync(mailLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(messagesSent.some(message => message.to === 'buyer@example.test' && message.text.includes('Out for delivery')));
  const retryFailure = await admin.send(`/api/admin/orders/${order.id}/tracking-email`, {
    method: 'POST', headers: jsonHeaders(admin), body: '{}'
  });
  assert.equal(retryFailure.response.status, 503);
});
