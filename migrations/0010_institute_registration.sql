-- Existing participants remain individual registrations.
ALTER TABLE registrations ADD COLUMN registration_type TEXT NOT NULL DEFAULT 'individual'
    CHECK (registration_type IN ('individual', 'institute'));
ALTER TABLE registrations ADD COLUMN institute_request_key TEXT;
ALTER TABLE registrations ADD COLUMN institute_request_hash TEXT;
ALTER TABLE registrations ADD COLUMN institute_email_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN institute_email_lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN institute_email_first_attempt_at INTEGER;
ALTER TABLE registrations ADD COLUMN institute_school_key TEXT;

DROP INDEX IF EXISTS idx_registration_email;
DROP INDEX IF EXISTS registrations_email_phone_unique;
DROP INDEX IF EXISTS idx_registration_email_phone;

CREATE UNIQUE INDEX idx_registration_email ON registrations(email COLLATE NOCASE)
    WHERE registration_type = 'individual';
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_phone ON registrations(phone);
CREATE UNIQUE INDEX idx_institute_request_key ON registrations(institute_request_key)
    WHERE institute_request_key IS NOT NULL;

-- Index all emails for the ownership checks, including shared school emails.
CREATE INDEX idx_registration_email_lookup ON registrations(email COLLATE NOCASE);

-- Atomically enforce the same policy for both registration routes and admin edits.
-- School keys are normalized in the Worker (case and whitespace are ignored).
CREATE TRIGGER registrations_email_owner_insert
BEFORE INSERT ON registrations
BEGIN
    SELECT CASE
        WHEN NEW.registration_type = 'institute' AND COALESCE(NEW.institute_school_key, '') = ''
            THEN RAISE(ABORT, 'institute_school_required')
        WHEN EXISTS (
            SELECT 1 FROM registrations r WHERE r.email = NEW.email COLLATE NOCASE
              AND ((NEW.registration_type = 'individual' AND r.registration_type = 'institute')
                   OR (NEW.registration_type = 'institute' AND
                       (r.registration_type <> 'institute' OR r.institute_school_key IS NOT NEW.institute_school_key)))
        ) THEN RAISE(ABORT, 'registration_email_conflict')
    END;
END;

CREATE TRIGGER registrations_email_owner_update
BEFORE UPDATE OF email, registration_type, institute_school_key ON registrations
BEGIN
    SELECT CASE
        WHEN NEW.registration_type = 'institute' AND COALESCE(NEW.institute_school_key, '') = ''
            THEN RAISE(ABORT, 'institute_school_required')
        WHEN EXISTS (
            SELECT 1 FROM registrations r WHERE r.id <> OLD.id AND r.email = NEW.email COLLATE NOCASE
              AND ((NEW.registration_type = 'individual' AND r.registration_type = 'institute')
                   OR (NEW.registration_type = 'institute' AND
                       (r.registration_type <> 'institute' OR r.institute_school_key IS NOT NEW.institute_school_key)))
        ) THEN RAISE(ABORT, 'registration_email_conflict')
    END;
END;
