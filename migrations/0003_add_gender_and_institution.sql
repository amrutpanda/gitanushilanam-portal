-- Migration number: 0003 	 2026-09-16T17:08:14.944Z
ALTER TABLE registrations ADD COLUMN gender TEXT;
ALTER TABLE registrations ADD COLUMN institution_organization TEXT;