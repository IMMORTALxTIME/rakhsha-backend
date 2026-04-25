// migrations/run.js
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const run = async () => {
  const client = await pool.connect();
  console.log('🔌 Connected to database');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        ran_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const migrationFiles = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of migrationFiles) {
      const { rows } = await client.query('SELECT id FROM migrations WHERE name=$1', [file]);
      if (rows.length) {
        console.log(`⏭️  Skipping ${file} (already ran)`);
        continue;
      }

      console.log(`▶️  Running migration: ${file}`);
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');

      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✅ Migration ${file} completed`);
    }

    console.log('\n🎉 All migrations complete!');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

run();
