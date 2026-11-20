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
const publicKey = '25654AAo79c3Bitcoin77BTCPUBqwIefT1j9fqqMwUtMI0huVL';
const privateKey = '25654AAo79c3Bitcoin77BTCPRV0JG7w3jg0Tc5Pfi34U8o5JE';

test('stock quantities and featured promotions stay consistent across order lifecycle', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'torquex-stock-'));
  const databasePath = path.join(directory, 'stock.sqlite');
  const port = 32000 + Math.floor(Math.random() * 20000);
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('legacy-user', 'Legacy Buyer', 'legacy@example.test', 'unused', 'customer', '2020-01-01');
    CREATE TABLE cars (id TEXT PRIMARY KEY, make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
      price_usd REAL NOT NULL, mileage INTEGER NOT NULL DEFAULT 0, transmission TEXT NOT NULL DEFAULT 'Automatic',
      body_type TEXT NOT NULL DEFAULT 'Sedan', description TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available', reserved_order TEXT, reserved_until TEXT, created_at TEXT NOT NULL);
    INSERT INTO cars VALUES ('legacy-car', 'Old', 'Car', 2020, 1000, 0, 'Automatic', 'Sedan', '', '',
      'reserved', 'legacy-order', NULL, '2020-01-01');
    CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
      payment_method TEXT NOT NULL, currency TEXT NOT NULL, subtotal_usd REAL NOT NULL, discount_usd REAL NOT NULL DEFAULT 0,
      total_usd REAL NOT NULL, promo_code TEXT, buyer_details TEXT NOT NULL, payment_details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, expires_at TEXT);
    INSERT INTO orders VALUES ('legacy-order', 'legacy-user', 'awaiting_bank_assignment', 'bank', 'USD', 1000,
      0, 1000, NULL, '{}', '{}', '2020-01-01', NULL);
    CREATE TABLE order_items (order_id TEXT NOT NULL REFERENCES orders(id), car_id TEXT NOT NULL REFERENCES cars(id),
      make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL, price_usd REAL NOT NULL, PRIMARY KEY (order_id, car_id));
    INSERT INTO order_items VALUES ('legacy-order', 'legacy-car', 'Old', 'Car', 2020, 1000);
  `);
  legacy.close();
  const mailLog = path.join(directory, 'mail.jsonl');
  const preload = path.join(directory, 'mock-mail.js');
  fs.writeFileSync(preload, `const mailer = require(${JSON.stringify(require.resolve('nodemailer'))});
    mailer.createTransport = () => ({ sendMail: async message => {
      require('node:fs').appendFileSync(${JSON.stringify(mailLog)}, JSON.stringify(message) + '\\n');
      return { accepted: [message.to] };
    } });`);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_PATH: databasePath,
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-password-12345',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '9', SMTP_USER: 'test', SMTP_PASSWORD: 'test',
      SMTP_FROM: 'test@example.test', PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      GTRANSLATE_ENABLED: 'false',
      GOURL_PUBLIC_KEY: publicKey, GOURL_PRIVATE_KEY: privateKey, GOURL_COIN: 'bitcoin' },
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
  assert.equal((await (await fetch(`${origin}/api/site-config`)).json()).gtranslateEnabled, false);

  async function session(email, password, name) {
    let cookie = '';
    let token = '';
    async function send(url, method = 'GET', body) {
      const response = await fetch(origin + url, { method, headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json', 'x-csrf-token': token } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const cookies = response.headers.getSetCookie?.() || [];
      if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
      const data = await response.json();
      if (data.token) token = data.token;
      return { status: response.status, body: data };
    }
    await send('/api/csrf');
    const auth = await send(name ? '/api/auth/register' : '/api/auth/login', 'POST', { email, password, ...(name ? { name } : {}) });
    assert.equal(auth.status, 200, JSON.stringify(auth.body));
    if (name) {
      const mail = fs.readFileSync(mailLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .filter(message => message.to === email && message.subject === 'Verify your TurqueX account').at(-1);
      const verified = await send('/api/auth/verification/confirm', 'POST', { code: mail.text.match(/\b\d{6}\b/)[0] });
      assert.equal(verified.status, 200, JSON.stringify(verified.body));
    }
    return send;
  }
  const admin = await session('admin@example.test', 'admin-password-12345');
  const customer = await session('buyer@example.test', 'buyer-password-12345', 'Buyer');
  assert.equal((await admin('/api/admin/orders')).body.orders.find(order => order.id === 'legacy-order').items[0].quantity, 1);
  assert.equal((await customer('/api/cars/legacy-car')).body.car.availableStock, 0);
  assert.equal((await admin('/api/admin/orders/legacy-order/status', 'PATCH', { status: 'cancelled' })).status, 200);
  assert.equal((await customer('/api/cars/legacy-car')).body.car.availableStock, 1);
  const listing = { make: 'Test', model: 'Fleet', year: 2025, priceUsd: 1000, mileage: 0,
    transmission: 'Automatic', bodyType: 'Sedan', availableStock: 5 };
  const car = await admin('/api/admin/cars', 'POST', listing);
  assert.equal(car.status, 201);
  const carId = car.body.car.id;

  const promo = await admin('/api/admin/promos', 'POST', {
    code: 'FLEET10', kind: 'percent', amount: 10, description: 'Fleet savings', usesLimit: 2
  });
  assert.equal(promo.status, 201);
  const fixed = await admin('/api/admin/promos', 'POST', {
    code: 'FIXED', kind: 'fixed', amount: 250, description: 'Fixed offer'
  });
  assert.equal(fixed.status, 201);
  const promos = (await admin('/api/admin/promos')).body.promos;
  const promoId = promos.find(p => p.code === 'FLEET10').id;
  const fixedId = promos.find(p => p.code === 'FIXED').id;
  assert.equal((await admin(`/api/admin/promos/${promoId}`, 'PATCH', { pinned: true })).status, 200);
  assert.deepEqual((await customer('/api/promos/featured')).body.promo, {
    code: 'FLEET10', kind: 'percent', amount: 10, description: 'Fleet savings', expiresAt: null
  });
  assert.equal((await admin(`/api/admin/promos/${fixedId}`, 'PATCH', { pinned: true })).status, 200);
  assert.equal((await customer('/api/promos/featured')).body.promo.code, 'FIXED');
  const fixedQuote = await customer('/api/promos/validate', 'POST', { code: 'FIXED', items: [{ carId, quantity: 2 }] });
  assert.equal(fixedQuote.body.discountUsd, 250);
  assert.equal(fixedQuote.body.totalUsd, 1750);
  assert.equal(fixedQuote.body.description, 'Fixed offer');
  assert.equal((await admin(`/api/admin/promos/${fixedId}`, 'PATCH', { active: false })).status, 200);
  assert.equal((await customer('/api/promos/featured')).body.promo, null);
  assert.equal((await admin(`/api/admin/promos/${fixedId}`, 'PATCH', { pinned: true })).status, 400);
  assert.equal((await admin(`/api/admin/promos/${promoId}`, 'PATCH', { pinned: true })).status, 200);
  const selection = [{ carId, quantity: 3 }];
  const quote = await customer('/api/promos/validate', 'POST', { code: 'fleet10', items: selection });
  assert.deepEqual(quote.body, { valid: true, code: 'FLEET10', kind: 'percent', amount: 10,
    description: 'Fleet savings', subtotalUsd: 3000, discountUsd: 300, totalUsd: 2700 });
  assert.equal((await customer('/api/promos/validate', 'POST', { code: 'FLEET10', items: [{ carId, quantity: 1.5 }] })).status, 400);
  assert.equal((await customer('/api/promos/validate', 'POST', { code: 'FLEET10', items: [{ carId, quantity: 1 }, { carId, quantity: 1 }] })).status, 400);
  assert.equal((await customer('/api/promos/validate', 'POST', { code: 'FLEET10', items: [{ carId, quantity: 6 }] })).status, 409);

  const buyer = { name: 'Buyer', email: 'buyer@example.test', phone: '+1 555 0100',
    address: '1 Test Street', city: 'Austin', country: 'US' };
  assert.equal((await admin('/api/admin/promos', 'POST', { code: 'BRAND50', kind: 'percent', amount: 50, brands: ['old'] })).status, 201);
  assert.equal((await admin('/api/admin/promos', 'POST', { code: 'ALL80', kind: 'percent', amount: 80 })).status, 201);
  assert.equal((await admin('/api/admin/promos', 'POST', { code: 'BRANDCAP', kind: 'fixed', amount: 5000, brands: ['Old', 'Test'] })).status, 201);
  assert.equal((await admin('/api/admin/promos', 'POST', { code: 'BADBRAND', kind: 'fixed', amount: 1, brands: ['Unknown'] })).status, 400);
  const mixed = [{ carId, quantity: 1 }, { carId: 'legacy-car', quantity: 1 }];
  const mixedQuote = await customer('/api/promos/validate', 'POST', { codes: ['BRAND50'], items: mixed });
  assert.equal(mixedQuote.body.discountUsd, 500);
  assert.equal(mixedQuote.body.totalUsd, 1500);
  assert.equal((await customer('/api/promos/validate', 'POST', { codes: ['BRAND50'], items: [{ carId, quantity: 1 }] })).status, 400);
  assert.equal((await customer('/api/promos/validate', 'POST', { codes: ['ALL80', 'all80'], items: mixed })).status, 400);
  assert.equal((await customer('/api/promos/validate', 'POST', { codes: ['ALL80', 'BRAND50', 'BRANDCAP'], items: mixed })).status, 400);
  const stacked = await customer('/api/promos/validate', 'POST', { codes: ['ALL80', 'BRAND50'], items: mixed });
  assert.deepEqual(stacked.body.promos.map(item => item.discountUsd), [1600, 200]);
  assert.equal(stacked.body.totalUsd, 200);
  assert.equal((await customer('/api/promos/validate', 'POST', { codes: ['BRANDCAP'], items: mixed })).body.discountUsd, 2000);
  const stackedOrder = await customer('/api/orders', 'POST', { items: mixed, paymentMethod: 'bank', currency: 'USD', buyer, promoCodes: ['ALL80', 'BRAND50'] });
  assert.equal(stackedOrder.status, 201);
  assert.deepEqual(stackedOrder.body.order.promoCodes, [{ code: 'ALL80', discountUsd: 1600 }, { code: 'BRAND50', discountUsd: 200 }]);
  assert.equal(stackedOrder.body.order.totalUsd, 200);
  assert.equal((await admin(`/api/admin/orders/${stackedOrder.body.order.id}/status`, 'PATCH', { status: 'cancelled' })).status, 200);
  const usedPromos = (await admin('/api/admin/promos')).body.promos;
  assert.equal(usedPromos.find(item => item.code === 'ALL80').usesCount, 1);
  assert.equal(usedPromos.find(item => item.code === 'BRAND50').usesCount, 1);
  const create = (items, promoCode) => customer('/api/orders', 'POST', { items, paymentMethod: 'bank', currency: 'USD', buyer, promoCode });
  const attempts = await Promise.all([create(selection, 'FLEET10'), create(selection, 'FLEET10')]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 409]);
  const first = attempts.find(result => result.status === 201).body.order;
  assert.equal(first.subtotalUsd, 3000);
  assert.equal(first.discountUsd, 300);
  assert.equal(first.totalUsd, 2700);
  assert.equal(first.items[0].quantity, 3);
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 2);
  assert.equal((await admin(`/api/admin/cars/${carId}`, 'PUT', { ...listing, expectedAvailableStock: 5 })).status, 409);
  const second = await create([{ carId, quantity: 2 }], 'FLEET10');
  assert.equal(second.status, 201);
  assert.equal(second.body.order.totalUsd, 1800);
  assert.equal((await customer('/api/promos/featured')).body.promo, null);
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.status, 'reserved');
  assert.equal((await admin(`/api/admin/orders/${first.id}/status`, 'PATCH', { status: 'cancelled' })).status, 200);
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 3);
  const bank = await admin('/api/admin/banks', 'POST', {
    bankName: 'Test Bank', accountName: 'Test Owner', accountNumber: '12345', currency: 'USD'
  });
  assert.equal(bank.status, 201);
  assert.equal((await admin(`/api/admin/orders/${second.body.order.id}/assign-bank`, 'POST', { bankId: bank.body.bank.id })).status, 200);
  assert.equal((await admin(`/api/admin/orders/${second.body.order.id}/status`, 'PATCH', { status: 'paid' })).status, 200);
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 3);
  const third = await create([{ carId, quantity: 2 }]);
  assert.equal(third.status, 201);
  assert.equal((await admin(`/api/admin/orders/${third.body.order.id}/assign-bank`, 'POST', { bankId: bank.body.bank.id })).status, 200);
  const db = new Database(databasePath);
  db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', third.body.order.id);
  db.close();
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 3);
  assert.equal((await customer(`/api/orders/${third.body.order.id}`)).body.order.status, 'expired');
  const counts = (await admin('/api/admin/summary')).body.counts;
  assert.equal(counts.cars_sold, 2);
  assert.equal(counts.cars_reserved, 0);

  const cryptoOrder = await customer('/api/orders', 'POST', {
    items: [{ carId, quantity: 2 }], paymentMethod: 'gourl', currency: 'USD', buyer
  });
  assert.equal(cryptoOrder.status, 201);
  const ipn = new URLSearchParams({ private_key_hash: crypto.createHash('sha512').update(privateKey).digest('hex'),
    status: 'payment_received', order: cryptoOrder.body.order.id, user: cryptoOrder.body.cryptoBox.userId, confirmed: '1' });
  const confirmed = await fetch(`${origin}/api/gourl/ipn`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: ipn
  });
  assert.equal(await confirmed.text(), 'cryptobox_updated');
  assert.equal((await customer(`/api/cars/${carId}`)).body.car.availableStock, 1);
  assert.equal((await admin('/api/admin/summary')).body.counts.cars_sold, 4);
  const edit = await admin(`/api/admin/cars/${carId}`, 'PUT', { ...listing, availableStock: 7, expectedAvailableStock: 1 });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.car.availableStock, 7);
  assert.equal((await customer('/api/promos/validate', 'POST', { code: 'FLEET10', items: selection })).status, 400);
  assert.equal((await admin(`/api/admin/promos/${fixedId}`, 'PATCH', { active: true })).status, 200);
  assert.equal((await admin(`/api/admin/promos/${fixedId}`, 'PATCH', { pinned: true })).status, 200);
  const expiryDb = new Database(databasePath);
  expiryDb.prepare('UPDATE promos SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', fixedId);
  expiryDb.close();
  assert.equal((await customer('/api/promos/featured')).body.promo, null);
  assert.equal((await customer('/api/promos/validate', 'POST', { code: 'FIXED', items: selection })).status, 400);
});
