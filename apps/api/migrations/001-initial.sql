CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  subject uuid NOT NULL,
  PRIMARY KEY (workspace_id, subject)
);
CREATE TABLE IF NOT EXISTS promotion_sites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  name text NOT NULL,
  homepage text NOT NULL,
  UNIQUE (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  subject uuid NOT NULL,
  request_id uuid NOT NULL,
  fingerprint text NOT NULL,
  source text NOT NULL CHECK (source IN ('csv', 'paste')),
  filename text,
  rows jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, site_id) REFERENCES promotion_sites (workspace_id, id),
  UNIQUE (workspace_id, site_id, subject, request_id)
);
