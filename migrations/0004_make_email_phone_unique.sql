-- Migration number: 0004 	 2026-09-19T17:10:03.475Z
DROP INDEX IF EXISTS idx_registration_email_phone;

CREATE UNIQUE INDEX idx_registration_email
ON registrations(email);

CREATE UNIQUE INDEX idx_registration_phone
ON registrations(phone);