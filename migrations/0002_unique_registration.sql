-- Normalize existing email/phone values and review duplicates before applying.
CREATE UNIQUE INDEX registrations_email_phone_unique
ON registrations (email, phone);
