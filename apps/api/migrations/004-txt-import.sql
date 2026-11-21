DO $$
BEGIN
  LOCK TABLE import_batches IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'import_batches'::regclass AND conname = 'import_batches_source_check'
  ) THEN
    ALTER TABLE import_batches
      DROP CONSTRAINT import_batches_source_check,
      ADD CONSTRAINT import_batches_source_type_check CHECK (source IN ('csv', 'paste', 'txt'));
  END IF;
END
$$;
