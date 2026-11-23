-- File collection only. No participant records are created by uploading a workbook.
-- School names deliberately are not unique; each deliberate upload is retained.
CREATE TABLE school_quiz_uploads (
    school_name TEXT NOT NULL,
    state TEXT,
    city TEXT,
    original_filename TEXT NOT NULL,
    file_key TEXT PRIMARY KEY NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 5242880),
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_school_quiz_uploads_date ON school_quiz_uploads(uploaded_at DESC, file_key);
CREATE INDEX idx_school_quiz_uploads_school ON school_quiz_uploads(school_name COLLATE NOCASE);
