'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');
const { createPostgresPool, createDatabase } = require('../postgres');

const testOptions = {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests.',
  timeout: 120000
};

async function startFixture(t, options = {}) {
  let url;
  try {
    url = new URL(process.env.TEST_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.searchParams.has('host') || url.searchParams.has('hostaddr')) {
    throw new Error('PostgreSQL tests require a local database URL without a host override.');
  }
  const schema = `torquex_test_${crypto.randomBytes(12).toString('hex')}`;
  const admin = new Client({ connectionString: url.toString() });
  let connected = false;
  let created = false;
  let pool;
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.kill();
      await exited;
      clearTimeout(timer);
    }
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
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
    pool = createPostgresPool(url.toString());
  } catch {
    throw new Error('Could not create or connect to the isolated PostgreSQL test schema.');
  }
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const selected = server.address().port;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const messages = [];
  const bootstrap = `
    const pending = new Map();
    let next = 0;
    process.on('message', message => {
      if (message.ack && pending.has(message.ack)) {
        pending.get(message.ack)();
        pending.delete(message.ack);
      }
    });
    require('nodemailer').createTransport = () => ({ sendMail: async message => {
      if (${JSON.stringify(options.failRecipients || [])}.includes(message.to)) throw new Error('Simulated mail failure');
      const id = ++next;
      await new Promise(resolve => {
        pending.set(id, resolve);
        process.send({ id, message });
      });
      return { accepted: [message.to] };
    } });
    global.fetch = async url => {
      if (${Boolean(options.mockRates)} && String(url) === 'https://open.er-api.com/v6/latest/USD') {
        return new Response(JSON.stringify({ result: 'success', rates: { USD: 1, EUR: 0.9, JPY: 150 }, time_last_update_utc: '2026-01-01T00:00:00Z' }), { status: 200 });
      }
      throw new Error('External network disabled in tests');
    };
    require('./server');
  `;
  child = spawn(process.execPath, ['-e', bootstrap], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: url.toString(),
      SESSION_SECRET: 'test-session-secret-at-least-32-characters',
      ADMIN_EMAIL: 'admin@example.test', ADMIN_PASSWORD: 'admin-password-12345',
      SMTP_HOST: 'mock', SMTP_USER: 'test', SMTP_PASSWORD: 'test', SMTP_FROM: 'store@example.test',
      PUBLIC_BASE_URL: origin, GTRANSLATE_ENABLED: 'false',
      GOURL_PUBLIC_KEY: '', GOURL_PRIVATE_KEY: '', ...options.env
    },
    stdio: ['ignore', 'pipe', 'ignore', 'ipc']
  });
  child.on('message', data => {
    messages.push(data.message);
    if (child.connected) child.send({ ack: data.id });
  });
  let output = '';
  let listening = false;
  child.stdout.on('data', chunk => {
    output = (output + String(chunk)).slice(-4096);
    if (output.includes('listening on')) listening = true;
  });
  for (let attempt = 0; attempt < 120 && !listening; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    await delay(250);
  }
  assert.ok(listening, 'Server did not start with the isolated test schema.');
  return { origin, messages, db: createDatabase(pool), pool };
}

module.exports = { startFixture, testOptions };
