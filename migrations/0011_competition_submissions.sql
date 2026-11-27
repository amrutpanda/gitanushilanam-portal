-- Submission access is separate from mentor and admin login.
CREATE TABLE participant_submission_sessions (
    session_hash TEXT PRIMARY KEY NOT NULL,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_submission_sessions_expiry ON participant_submission_sessions(expires_at);
CREATE TABLE participant_submission_attempts (
    attempt_key TEXT PRIMARY KEY NOT NULL,
    attempts INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX idx_submission_attempts_expiry ON participant_submission_attempts(expires_at);

-- A NULL link is a withdrawn submission. Its revision is retained for safe retries.
CREATE TABLE competition_submissions (
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    competition TEXT NOT NULL CHECK (competition IN ('shloka_recitation', 'animated_bg_video')),
    link TEXT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    first_submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (registration_id, competition)
);
CREATE TABLE competition_submission_history (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_hash TEXT NOT NULL,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    competition TEXT NOT NULL CHECK (competition IN ('shloka_recitation', 'animated_bg_video')),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('save', 'remove')),
    link TEXT,
    previous_link TEXT,
    changed_at TEXT NOT NULL,
    UNIQUE (registration_id, competition, revision)
);
CREATE INDEX idx_submission_history_participant ON competition_submission_history(registration_id, competition, revision DESC);

-- History and the current link commit together, including concurrent updates.
CREATE TRIGGER competition_submission_insert_history AFTER INSERT ON competition_submissions
BEGIN
    INSERT INTO competition_submission_history (request_id, request_hash, registration_id, competition, revision, action, link, previous_link, changed_at)
    VALUES (NEW.request_id, NEW.request_hash, NEW.registration_id, NEW.competition, NEW.revision, 'save', NEW.link, NULL, NEW.updated_at);
END;
CREATE TRIGGER competition_submission_update_history AFTER UPDATE ON competition_submissions
BEGIN
    INSERT INTO competition_submission_history (request_id, request_hash, registration_id, competition, revision, action, link, previous_link, changed_at)
    VALUES (NEW.request_id, NEW.request_hash, NEW.registration_id, NEW.competition, NEW.revision,
        CASE WHEN NEW.link IS NULL THEN 'remove' ELSE 'save' END, NEW.link, OLD.link, NEW.updated_at);
END;
