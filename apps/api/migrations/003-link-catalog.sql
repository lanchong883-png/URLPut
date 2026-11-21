CREATE TABLE IF NOT EXISTS external_link_catalog (
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  url_fingerprint text NOT NULL,
  normalized_url text NOT NULL,
  origin text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  observed_at timestamptz NOT NULL,
  reason text,
  PRIMARY KEY (workspace_id, url_fingerprint)
);

CREATE INDEX IF NOT EXISTS external_link_catalog_recheck_idx
  ON external_link_catalog (workspace_id, observed_at, url_fingerprint);
