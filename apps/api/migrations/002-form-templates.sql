CREATE TABLE IF NOT EXISTS form_templates (
  version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id),
  origin text NOT NULL,
  entry_type text NOT NULL,
  locale text NOT NULL,
  form_fingerprint text NOT NULL,
  form_shape jsonb NOT NULL,
  bindings_fingerprint text NOT NULL,
  bindings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, origin, entry_type, locale, form_fingerprint, bindings_fingerprint)
);

CREATE INDEX IF NOT EXISTS form_templates_lookup_idx
  ON form_templates (workspace_id, origin, entry_type, locale, form_fingerprint, version DESC);
