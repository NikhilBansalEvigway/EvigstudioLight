-- Improve audit log filtering performance for action/resource queries.

CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS "audit_logs_resource_type_idx" ON "audit_logs" ("resource_type");
