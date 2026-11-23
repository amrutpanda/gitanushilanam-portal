-- Applied only to the dedicated school-upload database, not the registration DB.
-- State/city stay NULL until the separate, later Excel import process.
CREATE TABLE school_quiz_uploads (
    school_name TEXT NOT NULL,
    state TEXT,
    city TEXT,
    original_filename TEXT NOT NULL,
    file_key TEXT PRIMARY KEY NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 2000000),
    uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_school_quiz_uploads_date ON school_quiz_uploads(uploaded_at DESC, file_key);
CREATE INDEX idx_school_quiz_uploads_school ON school_quiz_uploads(school_name COLLATE NOCASE);

-- 500,000-byte pieces encoded as base64 keep every row below D1's 2 MB limit.
-- The 100 MB application quota counts original file bytes, not storage encoding
-- or SQLite overhead; D1's separate database-size limit also applies.
CREATE TABLE school_quiz_upload_chunks (
    file_key TEXT NOT NULL REFERENCES school_quiz_uploads(file_key) ON DELETE CASCADE,
    part INTEGER NOT NULL CHECK (part BETWEEN 0 AND 3),
    content TEXT NOT NULL CHECK (length(content) BETWEEN 4 AND 666668),
    PRIMARY KEY (file_key, part)
);
