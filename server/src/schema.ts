export const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS verified_emails(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email TEXT NOT NULL,verified_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS devices (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS auth_sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS organizations (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 retention_days INTEGER NOT NULL DEFAULT 365 CHECK(retention_days BETWEEN 1 AND 3650),
 recording_allowed INTEGER NOT NULL DEFAULT 1 CHECK(recording_allowed IN(0,1)),
 public_sharing_allowed INTEGER NOT NULL DEFAULT 1 CHECK(public_sharing_allowed IN(0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS org_members (
 org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN('admin','manager','member')), joined_at TEXT NOT NULL,
 PRIMARY KEY(org_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS teams (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 name TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS team_members (
 team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN('manager','member')), PRIMARY KEY(team_id,user_id)
) STRICT;
CREATE TABLE IF NOT EXISTS resources (
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, entity TEXT NOT NULL, id TEXT NOT NULL,
 revision INTEGER NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 scope TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN('personal','org','team')),
 org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
 team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
 PRIMARY KEY(owner_id,entity,id)
) STRICT;
CREATE TABLE IF NOT EXISTS prompt_assignments (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL, entity TEXT NOT NULL DEFAULT 'mode' CHECK(entity='mode'), mode_id TEXT NOT NULL, assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL, assigned_at TEXT NOT NULL,
 FOREIGN KEY(owner_id,entity,mode_id) REFERENCES resources(owner_id,entity,id) ON DELETE CASCADE ON UPDATE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS resources_scope ON resources(org_id,team_id,entity);
CREATE TABLE IF NOT EXISTS changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entity TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT, deleted INTEGER NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS changes_user ON changes(user_id,sequence);
CREATE TABLE IF NOT EXISTS mutations (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, change_id TEXT NOT NULL,
 result TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(user_id,change_id)
) STRICT;
CREATE TABLE IF NOT EXISTS shares (
 token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 meeting_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(owner_id,meeting_id)
) STRICT;
CREATE TABLE IF NOT EXISTS usage_events (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE, kind TEXT NOT NULL, amount REAL NOT NULL,
 occurred_at TEXT NOT NULL, metadata TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
 actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, target TEXT NOT NULL, occurred_at TEXT NOT NULL
) STRICT;
`;
