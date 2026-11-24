'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const test = require('node:test');
const { Client } = require('pg');
const { createPostgresPool, initializePostgres, withTransaction, PostgresSessionStore } = require('../postgres');

test('PostgreSQL schema preserves uniqueness and rolls back failed transactions', {
  skip: !process.env.TEST_DATABASE_URL && 'Set TEST_DATABASE_URL to test PostgreSQL.'
}, async t => {
  const schema = `turquex_test_${crypto.randomBytes(8).toString('hex')}`;
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
  const admin = new Client({ connectionString: url.toString() });
  let connected = false;
  let created = false;
  let pool;
  t.after(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      try {
        if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        if (connected) await admin.end();
      }
    }
  });
  try {
    await admin.connect();
    connected = true;
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    url.searchParams.set('options', `-c search_path=${schema}`);
    pool = createPostgresPool(url.toString());
  } catch {
    throw new Error('Could not create or connect to the isolated PostgreSQL test schema.');
  }

  await initializePostgres(pool);
  await initializePostgres(pool);
  await pool.query(`INSERT INTO users (id, name, email, password_hash, created_at)
    VALUES ('one', 'User', 'USER@example.test', 'hash', '2026-01-01')`);
  await assert.rejects(pool.query(`INSERT INTO users (id, name, email, password_hash, created_at)
    VALUES ('two', 'User', 'user@example.test', 'hash', '2026-01-01')`), error => error.code === '23505');
  await assert.rejects(withTransaction(pool, async client => {
    await client.query("INSERT INTO settings (key, value) VALUES ('rollback', 'test')");
    throw new Error('transaction failed');
  }), /transaction failed/);
  assert.equal((await pool.query("SELECT key FROM settings WHERE key = 'rollback'")).rowCount, 0);

  const store = new PostgresSessionStore(pool);
  const set = promisify(store.set.bind(store));
  const get = promisify(store.get.bind(store));
  const touch = promisify(store.touch.bind(store));
  const destroy = promisify(store.destroy.bind(store));
  await set('session-1', { cookie: { expires: new Date(Date.now() + 60000) }, user: { id: 'one' } });
  assert.equal((await get('session-1')).user.id, 'one');
  await touch('session-1', { cookie: { expires: new Date(Date.now() - 1000) } });
  assert.equal(await get('session-1'), null);
  await destroy('session-1');
  assert.equal((await pool.query('SELECT sid FROM sessions WHERE sid = $1', ['session-1'])).rowCount, 0);
});

test('a connection is discarded when transaction rollback fails', async () => {
  const failure = new Error('transaction failed');
  const rollbackFailure = new Error('rollback failed');
  let releasedWith;
  const client = {
    async query(sql) {
      if (sql === 'ROLLBACK') throw rollbackFailure;
    },
    release(error) { releasedWith = error; }
  };
  await assert.rejects(withTransaction({ connect: async () => client }, async () => { throw failure; }),
    error => error === failure && error.rollbackError === rollbackFailure);
  assert.equal(releasedWith, rollbackFailure);
});

test('PostgreSQL bigint parser rejects values outside the safe integer range', async () => {
  const pool = createPostgresPool('postgresql://localhost/unused?options=-c%20search_path%3Dtorquex_test_0000000000000000');
  try {
    const parse = pool.options.types.getTypeParser(20, 'text');
    assert.equal(parse('9007199254740991'), Number.MAX_SAFE_INTEGER);
    assert.equal(parse('-9007199254740991'), Number.MIN_SAFE_INTEGER);
    assert.throws(() => parse('9007199254740992'), RangeError);
    assert.throws(() => parse('-9007199254740992'), RangeError);
  } finally {
    await pool.end();
  }
});
