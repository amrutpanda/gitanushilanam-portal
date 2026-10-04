-- Migration number: 0008 	 2026-10-04T14:39:02.407Z
-- ============================================================
-- Super Admin Phase 1 audit log
--
-- Important:
-- - This table records administrative changes made from the web.
-- - It does not create any delete capability.
-- - admin_id is nullable so an administrator can still be
--   permanently removed later by the database owner from D1
--   without destroying the historical audit record.
-- ============================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    admin_email TEXT NOT NULL,
    admin_role TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    old_values TEXT,
    new_values TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (admin_id)
        REFERENCES admin_accesslist(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at
    ON admin_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_id
    ON admin_audit_log(admin_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_entity
    ON admin_audit_log(entity_type, entity_id);