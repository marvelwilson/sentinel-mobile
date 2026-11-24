'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');

test('test-mode startup never implicitly loads .env', () => {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.DATABASE_URL;
  const script = `
    const fs = require('node:fs');
    const originalExists = fs.existsSync;
    fs.existsSync = value => String(value).endsWith(require('node:path').sep + '.env') || originalExists(value);
    process.loadEnvFile = () => process.exit(77);
    require('pg').Pool = class { constructor() { throw new Error('Database access blocked'); } };
    require('./server');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore', timeout: 10000
  });
  assert.equal(result.status, 1, 'Test startup must reject a missing DATABASE_URL without loading .env.');
});

test('PostgreSQL application integration', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests.',
  timeout: 120000
}, async t => {
  const { Client } = require('pg');
  const schema = `torquex_integration_${crypto.randomBytes(12).toString('hex')}`;
  let url;
  try {
    url = new URL(process.env.TEST_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new Error('PostgreSQL integration tests require a local database URL without a host override.');
  }
  const admin = new Client({ connectionString: url.toString() });
  let connected = false;
  let created = false;
  let database;
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise(resolve => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill();
      await exited;
      clearTimeout(timer);
    }
    try {
      if (database) await database.end();
    } finally {
      try {
        if (created) {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          const remaining = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
          assert.equal(remaining.rowCount, 0, 'Test schema was not removed.');
        }
      } finally {
        if (connected) await admin.end();
      }
    }
  });
  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Client({ connectionString: url.toString() });
    await database.connect();
  } catch {
    throw new Error('Could not create or connect to the isolated PostgreSQL test schema.');
  }

  const messages = [];
  const bootstrap = `
    require('nodemailer').createTransport = () => ({
      sendMail: async message => {
        if (process.send) process.send({ to: message.to, subject: message.subject, text: message.text });
        return { accepted: [message.to] };
      }
    });
    global.fetch = async () => { throw new Error('External network disabled in integration test'); };
    require('./server');
  `;
  async function startApp() {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const selected = server.address().port;
        server.close(error => error ? reject(error) : resolve(selected));
      });
    });
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['-e', bootstrap], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: url.toString(),
        SESSION_SECRET: 'test-session-secret-at-least-32-characters',
        ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-password-12345',
        SMTP_HOST: 'mock', SMTP_USER: 'mock', SMTP_PASSWORD: 'mock', SMTP_FROM: 'store@example.test',
        PUBLIC_BASE_URL: origin, GTRANSLATE_ENABLED: 'false',
        GOURL_PUBLIC_KEY: '', GOURL_PRIVATE_KEY: ''
      },
      stdio: ['ignore', 'pipe', 'ignore', 'ipc']
    });
    children.push(child);
    let stdout = '';
    let listening = false;
    child.on('message', message => messages.push(message));
    child.stdout.on('data', chunk => {
      stdout = (stdout + String(chunk)).slice(-4096);
      if (stdout.includes('listening on')) listening = true;
    });
    for (let attempt = 0; attempt < 120 && !listening; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(250);
    }
    assert.ok(listening, 'Application did not start with the isolated PostgreSQL schema.');
    return origin;
  }
  const starts = await Promise.allSettled([startApp(), startApp()]);
  const failedStart = starts.find(result => result.status === 'rejected');
  if (failedStart) throw failedStart.reason;
  const [origin, secondOrigin] = starts.map(result => result.value);
  assert.equal((await database.query('SELECT current_schema() AS name')).rows[0].name, schema);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM cars')).rows[0].count), 6);
  assert.equal(Number((await database.query("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'")).rows[0].count), 1);
  assert.equal((await fetch(`${origin}/api/site-config`)).status, 200);

  async function session(sessionOrigin = origin) {
    let cookie = '';
    let token = '';
    const send = async (route, method = 'GET', body, extraHeaders = {}, targetOrigin = sessionOrigin) => {
      const response = await fetch(targetOrigin + route, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? {
            'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
            'x-csrf-token': token
          } : {}),
          ...extraHeaders
        },
        ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {})
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
      const data = response.headers.get('content-type')?.startsWith('application/octet-stream')
        ? Buffer.from(await response.arrayBuffer()) : await response.json();
      if (data.token) token = data.token;
      return { status: response.status, body: data };
    };
    assert.equal((await send('/api/csrf')).status, 200);
    return send;
  }

  const customer = await session();
  const registration = await customer('/api/auth/register', 'POST', {
    name: 'Test Buyer', email: 'buyer@example.test', password: 'buyer-password-12345'
  });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.verificationRequired, true);
  assert.equal((await customer('/api/orders')).status, 401);
  let verificationMail;
  for (let attempt = 0; attempt < 40 && !verificationMail; attempt++) {
    verificationMail = messages.find(message =>
      message.to === 'buyer@example.test' && message.subject === 'Verify your TurqueX account');
    if (!verificationMail) await delay(50);
  }
  const code = verificationMail?.text?.match(/\b\d{6}\b/)?.[0];
  assert.ok(code, 'Mock mail transport did not receive a verification code.');
  assert.equal((await customer('/api/auth/verification/confirm', 'POST', { code })).status, 200);
  assert.equal((await customer('/api/me')).body.user.email, 'buyer@example.test');
  assert.equal((await customer('/api/me', 'GET', undefined, {}, secondOrigin)).body.user.email, 'buyer@example.test');
  assert.ok((await database.query('SELECT sid FROM sessions')).rowCount > 0);

  const secondCustomer = await session(secondOrigin);
  assert.equal((await secondCustomer('/api/auth/login', 'POST', {
    email: 'buyer@example.test', password: 'buyer-password-12345'
  })).status, 200);
  const adminSession = await session();
  assert.equal((await adminSession('/api/auth/login', 'POST', {
    email: 'admin@example.test', password: 'admin-password-12345'
  })).status, 200);
  const car = await adminSession('/api/admin/cars', 'POST', {
    make: 'Test', model: 'Fleet', year: 2025, priceUsd: 1000, mileage: 0,
    transmission: 'Automatic', bodyType: 'Sedan', availableStock: 3
  });
  assert.equal(car.status, 201);
  const carId = car.body.car.id;
  assert.equal((await adminSession('/api/admin/promos', 'POST', {
    code: 'LIMITED', kind: 'percent', amount: 10, usesLimit: 1
  })).status, 201);
  const buyer = {
    name: 'Test Buyer', email: 'buyer@example.test', phone: '+12025550123',
    address: '1 Test Street', city: 'Austin', country: 'US'
  };
  const order = send => send('/api/orders', 'POST', {
    items: [{ carId, quantity: 2 }], paymentMethod: 'bank', currency: 'USD', buyer, promoCode: 'LIMITED'
  });
  const attempts = await Promise.all([order(customer), order(secondCustomer)]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  const firstOrderId = attempts.find(result => result.status === 201).body.order.id;
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 1);
  assert.equal((await database.query("SELECT uses_count FROM promos WHERE code = 'LIMITED'")).rows[0].uses_count, 1);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM orders')).rows[0].count), 1);
  for (const send of [customer, adminSession]) {
    const route = send === customer ? '/api/orders' : '/api/admin/orders';
    const listed = await send(route);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.orders.find(item => item.id === firstOrderId).promoCodes,
      [{ code: 'LIMITED', discountUsd: 200 }]);
  }
  const summary = await adminSession('/api/admin/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.counts.orders, 1);
  assert.equal(summary.body.counts.cars_reserved, 2);
  const search = await adminSession('/api/admin/users?search=BUYER');
  assert.equal(search.status, 200);
  assert.equal(search.body.users.find(user => user.email === 'buyer@example.test').name, 'Test Buyer');

  assert.equal((await adminSession('/api/admin/promos', 'POST', {
    code: 'ROLLBACK', kind: 'percent', amount: 10, usesLimit: 1
  })).status, 201);
  await database.query(`CREATE FUNCTION fail_order_promo() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'intentional test failure'; END $$`);
  await database.query('CREATE TRIGGER fail_order_promo BEFORE INSERT ON order_promos FOR EACH ROW EXECUTE FUNCTION fail_order_promo()');
  const failed = await customer('/api/orders', 'POST', {
    items: [{ carId, quantity: 1 }], paymentMethod: 'bank', currency: 'USD', buyer, promoCode: 'ROLLBACK'
  });
  assert.equal(failed.status, 500);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM orders')).rows[0].count), 1);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM order_items')).rows[0].count), 1);
  assert.equal((await database.query("SELECT uses_count FROM promos WHERE code = 'ROLLBACK'")).rows[0].uses_count, 0);
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 1);
  await database.query('DROP TRIGGER fail_order_promo ON order_promos');

  const promoCar = await adminSession('/api/admin/cars', 'POST', {
    make: 'Test', model: 'Promo', year: 2025, priceUsd: 1000, mileage: 0,
    transmission: 'Automatic', bodyType: 'Sedan', availableStock: 2
  });
  assert.equal(promoCar.status, 201);
  const promoOrder = send => send('/api/orders', 'POST', {
    items: [{ carId: promoCar.body.car.id, quantity: 1 }],
    paymentMethod: 'bank', currency: 'USD', buyer, promoCode: 'ROLLBACK'
  });
  const promoAttempts = await Promise.all([promoOrder(customer), promoOrder(secondCustomer)]);
  assert.equal(promoAttempts.filter(result => result.status === 201).length, 1);
  assert.ok([400, 409].includes(promoAttempts.find(result => result.status !== 201).status));
  assert.equal((await database.query("SELECT uses_count FROM promos WHERE code = 'ROLLBACK'")).rows[0].uses_count, 1);
  assert.equal((await customer(`/api/cars/${promoCar.body.car.id}`)).body.car.availableStock, 1);
  const promoOrderId = promoAttempts.find(result => result.status === 201).body.order.id;
  assert.equal((await adminSession(`/api/admin/orders/${promoOrderId}/status`, 'PATCH', { status: 'cancelled' })).status, 200);
  assert.equal((await customer(`/api/cars/${promoCar.body.car.id}`)).body.car.availableStock, 2);

  const bank = await adminSession('/api/admin/banks', 'POST', {
    bankName: 'Test Bank', accountName: 'Test Owner', accountNumber: '12345', currency: 'USD'
  });
  assert.equal(bank.status, 201);
  assert.equal((await adminSession(`/api/admin/orders/${firstOrderId}/assign-bank`, 'POST', {
    bankId: bank.body.bank.id
  })).status, 200);
  assert.equal((await customer(`/api/orders/${firstOrderId}/payment-claim`, 'POST', {})).status, 200);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const proofHeaders = { 'x-proof-type': 'image/png' };
  assert.equal((await customer(`/api/orders/${firstOrderId}/payment-proof`, 'POST', png, proofHeaders)).status, 409);
  await database.query('UPDATE payment_proofs SET available_at = $1 WHERE order_id = $2',
    ['2020-01-01T00:00:00.000Z', firstOrderId]);
  assert.equal((await customer(`/api/orders/${firstOrderId}/payment-proof`, 'POST', png, proofHeaders)).status, 201);
  const proof = await adminSession(`/api/admin/orders/${firstOrderId}/payment-proof`);
  assert.equal(proof.status, 200);
  assert.deepEqual(proof.body, png);

  let availability = (await customer('/api/call-availability')).body;
  let day = availability.days.find(item => item.slots.length === 5);
  if (!day) {
    const [year, month] = availability.month.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
    availability = (await customer(`/api/call-availability?month=${nextMonth}`)).body;
    day = availability.days.find(item => item.slots.length === 5);
  }
  assert.ok(day, 'Expected a future weekday with available call slots.');
  const call = send => send('/api/call-requests', 'POST', {
    name: 'Test Buyer', email: 'buyer@example.test', phone: '+12025550123',
    preferredAt: day.slots[0], timezone: 'America/New_York', notes: ''
  });
  const bookings = await Promise.all([call(customer), call(secondCustomer)]);
  assert.deepEqual(bookings.map(result => result.status).sort(), [201, 409]);
  const updated = await customer(`/api/call-availability?month=${availability.month}`);
  assert.equal(updated.body.days.find(item => item.date === day.date).slots.includes(day.slots[0]), false);
  assert.equal(Number((await database.query('SELECT COUNT(*) AS count FROM call_requests')).rows[0].count), 1);
});
