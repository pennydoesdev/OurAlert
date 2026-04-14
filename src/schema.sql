-- OurALERT D1 Schema
-- Version: 0.1.0
-- This file is idempotent: safe to re-run with `wrangler d1 execute ouralert --remote --file=src/schema.sql`
-- All tables use `IF NOT EXISTS` and indexes use `IF NOT EXISTS` where supported.
--
-- For existing deployments, new columns are added via `ALTER TABLE ... ADD COLUMN` at the bottom.
-- SQLite silently ignores these if the column already exists... except it doesn't, so we use a
-- try/fallback pattern (the ALTERs will fail on re-runs against a schema that already has the column,
-- which is fine — re-run the file and only missed migrations will apply).

-- ============================================================================
-- REPORTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'observed',       -- 'critical' | 'active' | 'observed' | 'other'
  confirmed INTEGER NOT NULL DEFAULT 0,          -- 0 = not confirmed, 1 = mod-confirmed
  category TEXT NOT NULL DEFAULT 'ice',          -- 'ice' | 'military' | 'local_le' | 'other'
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  address TEXT NOT NULL,
  zip TEXT,
  city TEXT,
  state TEXT,
  activity_text TEXT,
  vehicle_count TEXT,                            -- '1' | '2-4' | '5+'
  official_count TEXT,                           -- '1' | '2-4' | '5-7' | '8+'
  agency_tags TEXT,                              -- JSON array
  activity_tags TEXT,                            -- JSON array
  arrestee_name TEXT,                            -- nullable, requires consent checkbox
  arrestee_consent INTEGER NOT NULL DEFAULT 0,
  uniform_description TEXT,
  possible_facility_id TEXT,                     -- FK to detention_facilities.id
  possible_facility_distance_mi REAL,
  time_occurred INTEGER NOT NULL,                -- unix ms
  time_submitted INTEGER NOT NULL,
  ip_hash TEXT,                                  -- SHA-256, deleted after 7 days
  moderation_state TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  moderator_id TEXT,                             -- FK to volunteers.id
  moderation_notes TEXT,
  reverse_image_checked INTEGER NOT NULL DEFAULT 0,
  metadata_verified INTEGER NOT NULL DEFAULT 0,
  -- Public visibility window (v0.1: reports disappear from public map after
  -- 24h but remain in D1 for analytics and the AlertIQ digest).
  pinned_until INTEGER,                          -- unix ms; if set and > now, report stays public
  hidden_from_public INTEGER NOT NULL DEFAULT 0, -- admin-forced hide even within window
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_mod_state ON reports(moderation_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_geo ON reports(lat, lon);
CREATE INDEX IF NOT EXISTS idx_reports_zip ON reports(zip);
CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category, moderation_state);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_ip_hash ON reports(ip_hash);
CREATE INDEX IF NOT EXISTS idx_reports_pinned ON reports(pinned_until) WHERE pinned_until IS NOT NULL;

-- ============================================================================
-- REPORT MEDIA
-- ============================================================================

CREATE TABLE IF NOT EXISTS report_media (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER,
  exif_stripped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_media_report ON report_media(report_id);

-- ============================================================================
-- DETENTION FACILITIES (seeded by scripts/seed-facilities.js)
-- ============================================================================

CREATE TABLE IF NOT EXISTS detention_facilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  lat REAL,
  lon REAL,
  facility_type TEXT,
  operator TEXT,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facilities_geo ON detention_facilities(lat, lon);
CREATE INDEX IF NOT EXISTS idx_facilities_state ON detention_facilities(state);

-- ============================================================================
-- ZIP CACHE
-- ============================================================================

CREATE TABLE IF NOT EXISTS zip_cache (
  zip TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  city TEXT,
  state TEXT,
  cached_at INTEGER NOT NULL
);

-- ============================================================================
-- RATE LIMITS
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, scope, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- ============================================================================
-- VOLUNTEERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS volunteers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,                            -- nullable if SSO-only
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'volunteer',        -- 'volunteer' | 'senior_mod' | 'admin'
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'active' | 'suspended'
  auth_provider TEXT NOT NULL DEFAULT 'password', -- 'password' | 'workos' | 'google'
  workos_user_id TEXT,                           -- nullable; set when auth_provider='workos'
  invited_by TEXT,
  invited_at INTEGER,
  last_login INTEGER,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_volunteers_email ON volunteers(email);
CREATE INDEX IF NOT EXISTS idx_volunteers_status ON volunteers(status, role);
CREATE INDEX IF NOT EXISTS idx_volunteers_workos ON volunteers(workos_user_id) WHERE workos_user_id IS NOT NULL;

-- ============================================================================
-- VOLUNTEER SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS volunteer_sessions (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_volunteer ON volunteer_sessions(volunteer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON volunteer_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON volunteer_sessions(expires_at);

-- ============================================================================
-- VOLUNTEER OTP (2FA email codes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS volunteer_otps (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_otps_volunteer ON volunteer_otps(volunteer_id, purpose);
CREATE INDEX IF NOT EXISTS idx_otps_expires ON volunteer_otps(expires_at);

-- ============================================================================
-- VOLUNTEER ACTIONS (audit log)
-- ============================================================================

CREATE TABLE IF NOT EXISTS volunteer_actions (
  id TEXT PRIMARY KEY,
  volunteer_id TEXT NOT NULL,
  report_id TEXT,
  action TEXT NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (volunteer_id) REFERENCES volunteers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_actions_volunteer ON volunteer_actions(volunteer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_report ON volunteer_actions(report_id);

-- ============================================================================
-- SUBSCRIBERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  zip TEXT NOT NULL,
  radius_mi INTEGER NOT NULL DEFAULT 50,
  lat REAL,
  lon REAL,
  alerts_enabled INTEGER NOT NULL DEFAULT 1,
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  digest_hour_utc INTEGER NOT NULL DEFAULT 13,
  push_player_id TEXT,
  quiet_hours_start INTEGER,
  quiet_hours_end INTEGER,
  verified INTEGER NOT NULL DEFAULT 0,
  verify_token TEXT,
  verify_sent_at INTEGER,
  unsubscribe_token TEXT NOT NULL,
  last_alert_sent_at INTEGER,
  last_digest_sent_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscribers_zip ON subscribers(zip, verified);
CREATE INDEX IF NOT EXISTS idx_subscribers_geo ON subscribers(lat, lon, verified);
CREATE INDEX IF NOT EXISTS idx_subscribers_digest ON subscribers(digest_enabled, digest_hour_utc, verified);
CREATE INDEX IF NOT EXISTS idx_subscribers_unsub ON subscribers(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_subscribers_verify ON subscribers(verify_token);

-- ============================================================================
-- ALERT DELIVERIES
-- ============================================================================

CREATE TABLE IF NOT EXISTS alert_deliveries (
  id TEXT PRIMARY KEY,
  subscriber_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  transport TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (subscriber_id, report_id, transport)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_report ON alert_deliveries(report_id);

-- ============================================================================
-- EMAIL QUEUE
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_queue (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  category TEXT NOT NULL,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  body_text TEXT,
  loops_template_id TEXT,
  loops_data_variables TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  scheduled_for INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_email_queue_category ON email_queue(category, created_at DESC);

-- ============================================================================
-- DIGEST CACHE
-- ============================================================================

CREATE TABLE IF NOT EXISTS digest_cache (
  id TEXT PRIMARY KEY,
  zip TEXT NOT NULL,
  radius_mi INTEGER NOT NULL,
  day TEXT NOT NULL,
  report_count INTEGER NOT NULL,
  summary_html TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  featherless_model TEXT,
  generated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_digest_day ON digest_cache(day, zip);

-- ============================================================================
-- ANALYTICS: EVENTS (30-day retention)
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_category TEXT,
  event_action TEXT,
  event_label TEXT,
  event_value INTEGER,
  session_id TEXT NOT NULL,
  params_json TEXT,
  path TEXT,
  referrer_domain TEXT,
  device TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  created_day TEXT NOT NULL,
  created_hour INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_day_name ON analytics_events(created_day, event_name);
CREATE INDEX IF NOT EXISTS idx_events_session ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_path_day ON analytics_events(path, created_day);
CREATE INDEX IF NOT EXISTS idx_events_category ON analytics_events(event_category, created_day);
CREATE INDEX IF NOT EXISTS idx_events_created ON analytics_events(created_at DESC);

-- ============================================================================
-- ANALYTICS: SESSIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  page_count INTEGER NOT NULL DEFAULT 1,
  country TEXT,
  device TEXT,
  landing_path TEXT,
  exit_path TEXT,
  referrer_domain TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  is_bounce INTEGER NOT NULL DEFAULT 1,
  ended INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sess_first_seen ON analytics_sessions(first_seen);
CREATE INDEX IF NOT EXISTS idx_sess_last_seen ON analytics_sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_sess_country ON analytics_sessions(country);

-- ============================================================================
-- ANALYTICS: DAILY ROLLUPS
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_daily (
  day TEXT NOT NULL,
  event_category TEXT NOT NULL,
  event_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'XX',
  device TEXT NOT NULL DEFAULT 'unknown',
  count INTEGER NOT NULL DEFAULT 0,
  unique_sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event_category, event_name, country, device)
);

CREATE TABLE IF NOT EXISTS analytics_paths_daily (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  unique_sessions INTEGER NOT NULL DEFAULT 0,
  avg_duration_seconds INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

CREATE TABLE IF NOT EXISTS analytics_referrers_daily (
  day TEXT NOT NULL,
  referrer_domain TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, referrer_domain)
);

CREATE TABLE IF NOT EXISTS analytics_utm_daily (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '(none)',
  medium TEXT NOT NULL DEFAULT '(none)',
  campaign TEXT NOT NULL DEFAULT '(none)',
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, medium, campaign)
);

CREATE TABLE IF NOT EXISTS analytics_retention_daily (
  day TEXT PRIMARY KEY,
  dau INTEGER NOT NULL DEFAULT 0,
  wau INTEGER NOT NULL DEFAULT 0,
  mau INTEGER NOT NULL DEFAULT 0,
  new_sessions INTEGER NOT NULL DEFAULT 0,
  returning_sessions INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- ANALYTICS: FUNNELS
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_funnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  steps_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_funnel_results (
  funnel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  step INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (funnel_id, day, step),
  FOREIGN KEY (funnel_id) REFERENCES analytics_funnels(id) ON DELETE CASCADE
);

-- ============================================================================
-- ANALYTICS: WEEKLY COHORTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_cohorts_weekly (
  cohort_week TEXT NOT NULL,
  offset_weeks INTEGER NOT NULL,
  returning_sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cohort_week, offset_weeks)
);

-- ============================================================================
-- ANALYTICS: TOTALS
-- ============================================================================

CREATE TABLE IF NOT EXISTS analytics_totals (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO analytics_totals (key, value, updated_at) VALUES
  ('all_time_views', 0, 0),
  ('all_time_reports', 0, 0),
  ('all_time_reports_approved', 0, 0),
  ('all_time_subscribers', 0, 0),
  ('all_time_alerts_sent', 0, 0),
  ('all_time_digests_sent', 0, 0),
  ('all_time_push_sent', 0, 0),
  ('all_time_api_calls', 0, 0);

INSERT OR IGNORE INTO analytics_funnels (id, name, description, steps_json, created_at) VALUES
  ('funnel_report_submission', 'Report Submission Funnel', 'Landing through report submission', '[{"step":1,"name":"Landing","event_name":"page_view","event_category":"engagement"},{"step":2,"name":"Opened report modal","event_name":"report_modal_open","event_category":"reports"},{"step":3,"name":"Started filling","event_name":"report_form_start","event_category":"reports"},{"step":4,"name":"Submitted","event_name":"report_submitted","event_category":"reports"}]', 0),
  ('funnel_alert_subscription', 'Alert Subscription Funnel', 'Landing through alert subscription', '[{"step":1,"name":"Landing","event_name":"page_view","event_category":"engagement"},{"step":2,"name":"Opened subscribe","event_name":"subscribe_modal_open","event_category":"alerts"},{"step":3,"name":"Submitted email","event_name":"subscribe_submitted","event_category":"alerts"},{"step":4,"name":"Verified","event_name":"subscribe_verified","event_category":"alerts"}]', 0),
  ('funnel_volunteer_onboarding', 'Volunteer Onboarding Funnel', 'Volunteer login and first action', '[{"step":1,"name":"Login page","event_name":"page_view","event_category":"engagement","path":"/volunteer"},{"step":2,"name":"Login submitted","event_name":"volunteer_login_submit","event_category":"auth"},{"step":3,"name":"2FA verified","event_name":"volunteer_2fa_verified","event_category":"auth"},{"step":4,"name":"First moderation","event_name":"volunteer_first_action","event_category":"auth"}]', 0);

-- ============================================================================
-- API KEYS — Phase 1p
-- Admin-granted keys for full-data access to /api/v1/* endpoints including
-- read and optional write (report submission bypassing Turnstile).
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                           -- 'ak_' prefix + nanoid
  key_hash TEXT NOT NULL UNIQUE,                 -- SHA-256 of the raw key; raw key shown once at creation
  key_prefix TEXT NOT NULL,                     -- first 8 chars of the raw key for identification (e.g. "ak_abcd")
  label TEXT NOT NULL,                           -- human-readable name ('NPR Research Team', 'RAICES Legal')
  owner_email TEXT NOT NULL,                     -- contact email (not for auth; for revocation/notification)
  owner_org TEXT,                                -- org name
  scopes_json TEXT NOT NULL,                     -- JSON array: ['read'] | ['read','post'] | ['read','post','mod']
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 1000,
  granted_by TEXT NOT NULL,                      -- FK to volunteers.id (admin who created)
  granted_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,                            -- NULL = active, non-null = revoked
  revoked_by TEXT,                               -- FK to volunteers.id
  revoke_reason TEXT,
  expires_at INTEGER,                            -- NULL = no expiry
  notes TEXT,                                    -- admin notes
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_email);
CREATE INDEX IF NOT EXISTS idx_api_keys_granted_by ON api_keys(granted_by);

-- ============================================================================
-- API KEY USAGE LOG
-- Every authenticated API call is logged for audit and abuse detection.
-- Retention: 90 days (cleaned up by nightly cron).
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_key_usage (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,                        -- e.g. '/api/v1/reports'
  method TEXT NOT NULL,                          -- 'GET' | 'POST'
  status INTEGER NOT NULL,                       -- HTTP response status
  bytes_returned INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_usage_key_time ON api_key_usage(key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_key_usage(created_at DESC);

-- ============================================================================
-- TREND SNAPSHOTS — Phase 1o
-- Pre-computed trend data used by both the public Hub & Trends page and
-- the admin trends dashboard. Refreshed by an hourly cron.
-- The `ai_summary_*` columns cache the Featherless-generated AlertIQ text.
-- ============================================================================

CREATE TABLE IF NOT EXISTS trend_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                           -- 'global' | 'state:CA' | 'city:Los Angeles,CA'
  period TEXT NOT NULL,                          -- 'last_24h' | 'last_7d' | 'last_30d'
  metrics_json TEXT NOT NULL,                    -- full metric payload
  report_count INTEGER NOT NULL,
  ai_summary_html TEXT,                          -- AlertIQ-generated HTML summary
  ai_summary_text TEXT,
  ai_model TEXT,                                 -- which Featherless model produced it
  ai_generated_at INTEGER,
  generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                    -- when this snapshot should be recomputed
);

CREATE INDEX IF NOT EXISTS idx_trend_scope_period ON trend_snapshots(scope, period, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_trend_expires ON trend_snapshots(expires_at);

-- ============================================================================
-- PUBLIC EXPORTS CACHE
-- Pre-computed aggregated data served by /api/public/* endpoints.
-- Refreshed every 15 min by cron so hot cache endpoints are microsecond-fast.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public_exports_cache (
  key TEXT PRIMARY KEY,                          -- e.g. 'aggregated_24h', 'by_state_7d'
  payload_json TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  generated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_exports_expires ON public_exports_cache(expires_at);

-- ============================================================================
-- COLUMN ADDITIONS for EXISTING deployments (ALTER TABLE migrations)
-- These statements MAY fail on re-runs if the column already exists; that's
-- expected and safe. Run this file with `wrangler d1 execute ... --file=`.
-- If you see "duplicate column" errors, they can be ignored.
-- ============================================================================

-- Report public-window fields (Phase 1c-bis)
-- Wrapped in DO NOTHING-style to be idempotent. D1 doesn't support DO blocks,
-- so these just fail silently on re-run and that's fine.
-- Uncomment on first migration run for existing DBs:
-- ALTER TABLE reports ADD COLUMN pinned_until INTEGER;
-- ALTER TABLE reports ADD COLUMN hidden_from_public INTEGER NOT NULL DEFAULT 0;

-- Volunteer SSO fields (Phase 1f-bis)
-- ALTER TABLE volunteers ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'password';
-- ALTER TABLE volunteers ADD COLUMN workos_user_id TEXT;
