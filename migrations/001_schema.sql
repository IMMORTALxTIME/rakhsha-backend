-- ============================================================
-- RAKHSHA DATABASE MIGRATIONS
-- Run in sequence: 001 → 002 → 003 → 004 → 005
-- Requires: PostgreSQL 14+ with PostGIS extension
-- ============================================================

-- ── 001_initial.sql ─────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            TEXT NOT NULL,
  phone           TEXT,                           -- AES-256 encrypted
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'user'    CHECK (role IN ('user','admin','guardian')),
  fcm_token       TEXT,
  emergency_contacts JSONB DEFAULT '[]',
  is_active       BOOLEAN DEFAULT TRUE,
  last_login      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_states (
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  state_key       TEXT NOT NULL,
  state_value     JSONB,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, state_key)
);

CREATE TABLE IF NOT EXISTS fake_callers (
  id              SERIAL PRIMARY KEY,
  caller_name     TEXT NOT NULL,
  caller_number   TEXT NOT NULL,
  ringtone_url    TEXT,
  caller_image_url TEXT,
  call_script     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── 002_postgis.sql ──────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS routes (
  id              SERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  path            GEOGRAPHY(LINESTRING, 4326),
  risk_score      FLOAT DEFAULT 0,
  route_type      TEXT DEFAULT 'shortest'         CHECK (route_type IN ('shortest','lit_street','reroute')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id              SERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  type            TEXT NOT NULL,
  description     TEXT,
  severity        INTEGER DEFAULT 3               CHECK (severity BETWEEN 1 AND 5),
  image_url       TEXT,
  audio_url       TEXT,
  status          TEXT DEFAULT 'active'           CHECK (status IN ('active','reviewed','dismissed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refuges (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  type            TEXT NOT NULL                   CHECK (type IN ('police','hospital','shelter','cafe','pharmacy','fire_station')),
  hours           TEXT,
  phone           TEXT,
  is_24h          BOOLEAN DEFAULT FALSE,
  verified        BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crime_history (
  id              SERIAL PRIMARY KEY,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  crime_type      TEXT NOT NULL,
  severity        INTEGER NOT NULL                CHECK (severity BETWEEN 1 AND 10),
  description     TEXT,
  source          TEXT DEFAULT 'police_report',
  timestamp       TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sos_events (
  id              SERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  location        GEOGRAPHY(POINT, 4326),
  audio_url       TEXT,
  image_url       TEXT,
  message         TEXT,
  status          TEXT DEFAULT 'active'           CHECK (status IN ('active','resolved','cancelled','false_alarm')),
  contacts_alerted JSONB DEFAULT '[]',
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS location_history (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,
  accuracy        FLOAT,
  heading         FLOAT,
  speed           FLOAT,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guardian_relationships (
  id              SERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  guardian_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  permissions     JSONB DEFAULT '["view_location"]',
  status          TEXT DEFAULT 'pending'          CHECK (status IN ('pending','active','declined','revoked')),
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, guardian_id)
);

CREATE TABLE IF NOT EXISTS checkins (
  id              SERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  location        GEOGRAPHY(POINT, 4326),
  note            TEXT,
  battery_level   INTEGER                         CHECK (battery_level BETWEEN 0 AND 100),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS streets (
  id              SERIAL PRIMARY KEY,
  name            TEXT,
  path            GEOGRAPHY(LINESTRING, 4326),
  is_lit          BOOLEAN DEFAULT FALSE,
  lighting_score  INTEGER DEFAULT 0              CHECK (lighting_score BETWEEN 0 AND 10),
  surface_type    TEXT,
  last_updated    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 003_indexes.sql ──────────────────────────────────────────
-- Spatial indexes (critical for PostGIS performance)
CREATE INDEX IF NOT EXISTS idx_routes_path         ON routes       USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_reports_location    ON reports      USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_refuges_location    ON refuges      USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_crime_location      ON crime_history USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_sos_location        ON sos_events   USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_location_hist       ON location_history USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_checkins_location   ON checkins     USING GIST (location);
CREATE INDEX IF NOT EXISTS idx_streets_path        ON streets      USING GIST (path);

-- Regular indexes
CREATE INDEX IF NOT EXISTS idx_users_email         ON users (email);
CREATE INDEX IF NOT EXISTS idx_routes_user         ON routes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_user        ON reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_type        ON reports (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crime_timestamp     ON crime_history (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sos_user            ON sos_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sos_status          ON sos_events (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_loc_user_time       ON location_history (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_guardian_user       ON guardian_relationships (user_id);
CREATE INDEX IF NOT EXISTS idx_guardian_guardian   ON guardian_relationships (guardian_id);
CREATE INDEX IF NOT EXISTS idx_checkins_user       ON checkins (user_id, created_at DESC);

-- ── 004_triggers.sql ─────────────────────────────────────────
-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-cleanup location history older than 30 days (runs via cron)
CREATE OR REPLACE FUNCTION cleanup_old_locations()
RETURNS void AS $$
BEGIN
  DELETE FROM location_history WHERE recorded_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- ── 005_ml_tables.sql ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ml_predictions (
  id              SERIAL PRIMARY KEY,
  lat             FLOAT NOT NULL,
  lng             FLOAT NOT NULL,
  risk_score      FLOAT NOT NULL,
  model_version   TEXT,
  features        JSONB,
  predicted_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_location ON ml_predictions (lat, lng);
CREATE INDEX IF NOT EXISTS idx_ml_time     ON ml_predictions (predicted_at DESC);

-- ── SEED DATA ────────────────────────────────────────────────
INSERT INTO fake_callers (caller_name, caller_number, call_script) VALUES
  ('Mom', '+91 98765 00001', 'Where are you? Please come home now, dinner is ready.'),
  ('Priya (Sister)', '+91 98765 00002', 'I need you to come quickly, it''s important.'),
  ('Office - HR', '+91 11 4567 0000', 'This is a reminder about tomorrow''s 9 AM meeting.'),
  ('Dr. Sharma (Clinic)', '+91 11 2345 6789', 'Calling regarding your appointment scheduled for tomorrow.'),
  ('Rahul (Colleague)', '+91 95432 10001', 'Hey, are you still at the office? We have that thing.')
ON CONFLICT DO NOTHING;
