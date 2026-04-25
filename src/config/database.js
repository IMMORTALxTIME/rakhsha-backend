// src/config/database.js
const { Pool } = require('pg');
const { logger } = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  min: parseInt(process.env.DB_POOL_MIN) || 2,
  max: parseInt(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New DB connection established');
});

/**
 * Execute a query with automatic connection management
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { duration, rows: res.rowCount });
    return res;
  } catch (err) {
    logger.error('DB query error', { query: text, error: err.message });
    throw err;
  }
};

/**
 * Transaction helper — pass a callback(client) that does all queries
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

const testConnection = async () => {
  try {
    await pool.query('SELECT NOW()');
    logger.info('✅ PostgreSQL connected successfully');
  } catch (err) {
    logger.error('❌ PostgreSQL connection failed', { error: err.message });
    throw err;
  }
};

module.exports = { pool, query, transaction, testConnection };
