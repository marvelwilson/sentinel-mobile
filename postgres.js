'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const session = require('express-session');
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

function createPostgresPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL.');
  let url;
  try {
    url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (process.env.NODE_ENV === 'test') {
    const options = url.searchParams.getAll('options');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
      url.searchParams.has('host') || url.searchParams.has('hostaddr') ||
      options.length !== 1 || !/^-c search_path=torquex_(?:test|integration)_[a-f0-9]{16,}$/.test(options[0])) {
      throw new Error('Tests require a local DATABASE_URL with a unique isolated torquex test schema.');
    }
  }
  let ssl;
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.DATABASE_SSL_CA) throw new Error('DATABASE_SSL_CA must contain the trusted PostgreSQL CA certificate in production.');
    if (url.searchParams.getAll('sslmode').some(mode => !['verify-ca', 'verify-full'].includes(mode))) {
      throw new Error('Production DATABASE_URL sslmode must be verify-ca or verify-full.');
    }
    if (url.searchParams.getAll('ssl').some(value => ['0', 'false'].includes(value.toLowerCase()))) {
      throw new Error('Production DATABASE_URL cannot disable TLS.');
    }
    if (url.searchParams.getAll('sslnegotiation').some(value => value.toLowerCase() === 'direct')) {
      throw new Error('Direct SSL negotiation is not supported with production CA configuration.');
    }
    for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
    connectionString = url.toString();
    ssl = { ca: process.env.DATABASE_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  }
  const pool = new Pool({
    connectionString,
    ssl,
    types: {
      getTypeParser(oid, format) {
        if (oid !== 20 || format === 'binary') return types.getTypeParser(oid, format);
        return value => {
          const number = Number(value);
          if (!Number.isSafeInteger(number)) throw new RangeError('PostgreSQL bigint exceeds the JavaScript safe integer range.');
          return number;
        };
      }
    }
  });
  pool.on('error', error => console.error('PostgreSQL pool error:', error));
  return pool;
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function initializePostgres(pool) {
  const schema = await fs.readFile(path.join(__dirname, 'postgres-schema.sql'), 'utf8');
  await withTransaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('turquex-schema'))");
    await client.query(schema);
  });
}

function createDatabase(pool) {
  const context = new AsyncLocalStorage();
  const statement = sql => {
    let parameter = 0;
    sql = sql.replace(/\?/g, () => `$${++parameter}`);
    const execute = async (...values) => (context.getStore() || pool).query(sql, values);
    return {
      get: async (...values) => (await execute(...values)).rows[0],
      all: async (...values) => (await execute(...values)).rows,
      run: async (...values) => {
        const result = await execute(...values);
        return { changes: result.rowCount, insertedId: result.rows[0]?.id };
      }
    };
  };
  const transaction = operation => {
    const run = async () => {
      if (context.getStore()) return operation();
      return withTransaction(pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('turquex-write-transactions'))");
        return context.run(client, operation);
      });
    };
    return run;
  };
  return { prepare: statement, transaction };
}

class PostgresSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  get(sid, callback) {
    this.pool.query('SELECT sess FROM sessions WHERE sid = $1 AND expires > $2', [sid, Date.now()])
      .then(result => callback(null, result.rows.length ? JSON.parse(result.rows[0].sess) : null))
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    this.pool.query(`INSERT INTO sessions (sid, sess, expires) VALUES ($1, $2, $3)
      ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expires = EXCLUDED.expires`,
    [sid, JSON.stringify(sess), expires]).then(() => callback(null), callback);
  }

  touch(sid, sess, callback = () => {}) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    this.pool.query('UPDATE sessions SET expires = $1 WHERE sid = $2', [expires, sid])
      .then(() => callback(null), callback);
  }

  destroy(sid, callback = () => {}) {
    this.pool.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => callback(null), callback);
  }
}

module.exports = { createPostgresPool, initializePostgres, withTransaction, PostgresSessionStore, createDatabase };
