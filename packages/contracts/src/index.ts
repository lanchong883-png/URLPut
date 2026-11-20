import { z } from 'zod';

export const MAX_ROWS = 5_000;
export const MAX_IMPORT_BYTES = 2_000_000;

export const importBatchSchema = z.object({
  requestId: z.uuid(),
  source: z.enum(['csv', 'paste']),
  filename: z.string().max(255).optional(),
  rows: z.array(z.object({
    sourceLine: z.number().int().positive(),
    url: z.string().max(8192),
    entry: z.string().max(8192),
    name: z.string().max(2048),
    notes: z.string().max(8192),
  })).min(1).max(MAX_ROWS),
});

export type ImportBatch = z.infer<typeof importBatchSchema>;

export const siteSchema = z.object({ id: z.uuid(), name: z.string(), homepage: z.string() });
export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sites: z.array(siteSchema),
});

export type Workspace = z.infer<typeof workspaceSchema>;
