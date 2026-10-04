-- Migration number: 0006 	 2026-10-04T10:40:39.371Z
-- ============================================================
-- Gitanushilanam Admin Authentication
-- Extends the existing admin_accesslist table.
-- Run this migration only once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Extend existing admin access list
--
-- Passwords are never stored directly.
-- Only the PBKDF2 password hash and its salt are stored.
-- ------------------------------------------------------------

ALTER TABLE admin_accesslist ADD COLUMN password_salt TEXT;
ALTER TABLE admin_accesslist ADD COLUMN password_hash TEXT;
ALTER TABLE admin_accesslist ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 210000;
ALTER TABLE admin_accesslist ADD COLUMN password_changed_at TEXT;
ALTER TABLE admin_accesslist ADD COLUMN last_login_at TEXT;


-- ------------------------------------------------------------
-- 2. Admin sessions
--
-- The browser receives the real random session token.
-- D1 stores only the SHA-256 hash of that token.
-- Sessions will normally expire after one hour.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    session_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT,
    FOREIGN KEY (admin_id) REFERENCES admin_accesslist(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_hash ON admin_sessions(session_hash);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);


-- ------------------------------------------------------------
-- 3. Failed login attempt tracking
--
-- This table is used for simple brute-force protection.
-- The Worker creates attempt_key from the normalized email
-- address and the client IP address, then hashes the value.
--
-- For example, after five failed attempts, the Worker can
-- temporarily block further login attempts for 15 minutes.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_login_attempts (
    attempt_key TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    window_expires_at INTEGER NOT NULL,
    last_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_expiry ON admin_login_attempts(window_expires_at);


-- ------------------------------------------------------------
-- 4. Admin login history
--
-- Keeps an audit trail of authentication activity.
--
-- admin_id can be NULL because a failed login attempt may use
-- an email address that is not present in admin_accesslist.
--
-- Examples:
--     login_success
--     login_failure
--     logout
--     session_expired
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS admin_login_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    email_attempted TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'login_success',
            'login_failure',
            'logout',
            'session_expired'
        )
    ),
    failure_reason TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admin_accesslist(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_login_history_admin ON admin_login_history(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_login_history_email ON admin_login_history(email_attempted);
CREATE INDEX IF NOT EXISTS idx_admin_login_history_event ON admin_login_history(event_type);
CREATE INDEX IF NOT EXISTS idx_admin_login_history_created ON admin_login_history(created_at);


-- ------------------------------------------------------------
-- Final database usage
--
-- admin_accesslist:
--     Stores approved administrators and password hashes.
--
-- admin_sessions:
--     Stores active admin sessions using hashed session tokens.
--
-- admin_login_attempts:
--     Stores temporary failed-login counters for rate limiting.
--
-- admin_login_history:
--     Stores permanent login/logout/security audit history.
-- ------------------------------------------------------------