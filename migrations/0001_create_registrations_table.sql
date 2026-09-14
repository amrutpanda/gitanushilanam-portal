-- Migration number: 0001 	 2026-09-14T11:19:17.003Z
CREATE TABLE registrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    whatsapp TEXT NOT NULL,

    age INTEGER NOT NULL,

    country TEXT NOT NULL,
    state TEXT NOT NULL,
    city TEXT NOT NULL,

    heard_from TEXT,

    bhagavad_gita_quiz INTEGER NOT NULL DEFAULT 0,
    shloka_recitation INTEGER NOT NULL DEFAULT 0,
    animated_bg_video INTEGER NOT NULL DEFAULT 0,
    treasure_hunt INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);