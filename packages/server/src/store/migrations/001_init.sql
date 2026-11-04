-- extshare initial schema. Timestamps are epoch milliseconds; booleans are 0/1.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER NOT NULL DEFAULT 0,
  disabled        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL CHECK (role IN ('owner', 'publisher', 'viewer')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  mfa_passed    INTEGER NOT NULL DEFAULT 0,
  csrf          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
  hash          TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  family        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  used_at       INTEGER
);
CREATE INDEX api_tokens_family ON api_tokens(family);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

CREATE TABLE device_grants (
  id                TEXT PRIMARY KEY,
  device_code_hash  TEXT NOT NULL UNIQUE,
  user_code         TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  user_id           TEXT REFERENCES users(id),
  workspace_id      TEXT REFERENCES workspaces(id),
  client_name       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  last_poll_at      INTEGER NOT NULL
);

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  item_id       TEXT NOT NULL UNIQUE,
  visibility    TEXT NOT NULL CHECK (visibility IN ('private', 'unlisted')),
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX projects_workspace ON projects(workspace_id);

CREATE TABLE releases (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  kind                TEXT NOT NULL CHECK (kind IN ('build', 'withdrawal')),
  version             TEXT NOT NULL,
  state               TEXT NOT NULL,
  state_detail        TEXT NOT NULL DEFAULT '',
  sha256              TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  notes               TEXT NOT NULL DEFAULT '',
  findings_json       TEXT NOT NULL DEFAULT '[]',
  publish_type        TEXT NOT NULL CHECK (publish_type IN ('DEFAULT_PUBLISH', 'STAGED_PUBLISH')),
  uploaded_to_store   INTEGER NOT NULL DEFAULT 0,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  revoke_reason       TEXT NOT NULL DEFAULT '',
  last_sync_at        INTEGER
);
CREATE INDEX releases_project ON releases(project_id, created_at);
CREATE INDEX releases_state ON releases(state);

CREATE TABLE release_testers (
  release_id  TEXT NOT NULL REFERENCES releases(id),
  email       TEXT NOT NULL,
  added_by    TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (release_id, email)
);

CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  release_id  TEXT NOT NULL REFERENCES releases(id),
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX invites_release ON invites(release_id);

CREATE TABLE tester_sessions (
  id_hash     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Append-only: the application never updates or deletes audit rows.
CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT NOT NULL,
  ip            TEXT,
  details_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_workspace ON audit_log(workspace_id, at);
CREATE INDEX audit_target ON audit_log(target, at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
