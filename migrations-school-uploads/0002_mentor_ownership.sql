-- Additive migration: old uploaded files remain available to Super Admin.
-- The mentor lives in a different D1 database; ownership is checked by the API.
ALTER TABLE school_quiz_uploads ADD COLUMN school_registration_id INTEGER;
ALTER TABLE school_quiz_uploads ADD COLUMN mentor_id TEXT;
ALTER TABLE school_quiz_uploads ADD COLUMN mentor_name TEXT;
ALTER TABLE school_quiz_uploads ADD COLUMN district TEXT;
ALTER TABLE school_quiz_uploads ADD COLUMN uploaded_by_role TEXT CHECK (uploaded_by_role IN ('mentor', 'super_admin'));
ALTER TABLE school_quiz_uploads ADD COLUMN uploaded_by_id TEXT;
CREATE INDEX idx_school_quiz_uploads_mentor ON school_quiz_uploads(mentor_id, uploaded_at DESC, file_key);
CREATE INDEX idx_school_quiz_uploads_registration ON school_quiz_uploads(school_registration_id);
