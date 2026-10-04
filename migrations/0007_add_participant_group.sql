-- Migration number: 0007 	 2026-10-04T12:05:11.635Z
-- ============================================================
-- Add participant group to registrations
--
-- This stores the participant category used for registration
-- management and competition eligibility.
--
-- Allowed values used by the application:
--
--     sub_junior
--     junior
--     senior
--     youth_adult
--
-- Existing registrations remain valid because this column is
-- nullable. New registrations will require participant_group.
-- ============================================================

ALTER TABLE registrations ADD COLUMN participant_group TEXT;