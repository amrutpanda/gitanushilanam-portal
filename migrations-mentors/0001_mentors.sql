-- Separate mentor database. Participant registrations remain in their existing database.
CREATE TABLE mentor_schools (
    registration_id INTEGER PRIMARY KEY CHECK (registration_id BETWEEN 10000 AND 19999),
    identity_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    state TEXT NOT NULL,
    district TEXT NOT NULL,
    place TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE mentors (
    id TEXT PRIMARY KEY NOT NULL,
    school_id INTEGER NOT NULL REFERENCES mentor_schools(registration_id),
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE,
    phone TEXT NOT NULL,
    designation TEXT NOT NULL,
    total_strength INTEGER NOT NULL CHECK (total_strength BETWEEN 1 AND 10000000),
    willing_count INTEGER NOT NULL CHECK (willing_count BETWEEN 0 AND total_strength),
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    email_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (school_id, email, phone)
);
CREATE INDEX idx_mentors_login ON mentors(email, phone);
CREATE INDEX idx_mentors_created ON mentors(created_at DESC, id);
CREATE TABLE mentor_sessions (
    session_hash TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_mentor_sessions_expiry ON mentor_sessions(expires_at);
CREATE TABLE mentor_login_attempts (
    attempt_key TEXT PRIMARY KEY NOT NULL,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_mentor_attempts_expiry ON mentor_login_attempts(expires_at);
CREATE TABLE mentor_confirmation_jobs (
    job_key TEXT PRIMARY KEY NOT NULL,
    mentor_id TEXT NOT NULL REFERENCES mentors(id),
    sent INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0, 1)),
    first_attempt_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0
);
