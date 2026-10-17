CREATE TABLE IF NOT EXISTS whatsapp_group_links (
  participant_group TEXT PRIMARY KEY CHECK (
    participant_group IN (
      'sub_junior',
      'junior',
      'senior',
      'youth_adult'
    )
  ),
  bhagavad_gita_quiz TEXT NOT NULL,
  shloka_recitation TEXT NOT NULL,
  animated_bg_video TEXT NOT NULL,
  treasure_hunt TEXT NOT NULL
);
