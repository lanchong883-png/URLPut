import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { importBatchSchema, MAX_IMPORT_REQUEST_BYTES } from '@urlput/contracts';
import { buildLedger, type LedgerRow } from '@urlput/import';
import type { Database } from './database.ts';
import { registerFormTemplates } from './form-templates.ts';
import { registerLinkCatalog } from './link-catalog.ts';

const siteParams = z.object({ workspaceId: z.uuid(), siteId: z.uuid() });
const batchParams = siteParams.extend({ batchId: z.uuid() });

type BatchRow = {
  id: string;
  fingerprint: string;
  rows: LedgerRow[];
  source: string;
  filename: string | null;
  createdAt: string;
};

function publicBatch({ id, rows, source, filename, createdAt }: BatchRow) {
  return { id, rows, source, filename, createdAt };
}

export function createApp(
  db: Database,
  authenticate: (request: FastifyRequest) => Promise<string | undefined>,
  allowedOrigin?: string | RegExp,
) {
  const app = Fastify({ bodyLimit: MAX_IMPORT_REQUEST_BYTES });
  if (allowedOrigin) app.register(cors, { origin: allowedOrigin, methods: ['GET', 'POST'] });

  app.get('/health', async () => {
    await db.query(sql`SELECT 1`);
    return { ok: true };
  });

  app.register(async api => {
    const identities = new WeakMap<FastifyRequest, string>();
    api.addHook('onRequest', async (request, reply) => {
      const subject = await authenticate(request);
      if (!z.uuid().safeParse(subject).success || !subject) {
        return reply.code(401).send({ message: '请先登录。' });
      }
      identities.set(request, subject);
    });

    const subjectOf = (request: FastifyRequest) => identities.get(request)!;
    registerFormTemplates(api, db, subjectOf);
    registerLinkCatalog(api, db, subjectOf);

    api.get('/workspaces', async request => {
      const subject = identities.get(request)!;
      return db.query(sql`
        SELECT w.id, w.name, COALESCE(
          jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'homepage', p.homepage) ORDER BY p.name)
            FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb
        ) AS sites
        FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
        LEFT JOIN promotion_sites p ON p.workspace_id = w.id
        WHERE m.subject = ${subject}
        GROUP BY w.id ORDER BY w.name
      `);
    });

    const siteRoute = '/workspaces/:workspaceId/sites/:siteId/imports';

    api.post(siteRoute, async (request, reply) => {
      const params = siteParams.safeParse(request.params);
      const body = importBatchSchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ message: '导入内容无效或超过长度限制。' });

      const { workspaceId, siteId } = params.data;
      const { requestId, source, filename, rows } = body.data;
      const subject = identities.get(request)!;
      const ledger = buildLedger(rows);
      const fingerprint = createHash('sha256').update(JSON.stringify({ source, filename, rows })).digest('hex');

      const [batch] = await db.query<BatchRow>(sql`
        INSERT INTO import_batches (id, workspace_id, site_id, subject, request_id, fingerprint, source, filename, rows)
        SELECT ${randomUUID()}, p.workspace_id, p.id, m.subject, ${requestId}, ${fingerprint},
          ${source}, ${filename ?? null}, ${JSON.stringify(ledger)}::jsonb
        FROM promotion_sites p JOIN workspace_members m ON m.workspace_id = p.workspace_id
        WHERE p.id = ${siteId} AND p.workspace_id = ${workspaceId} AND m.subject = ${subject}
        ON CONFLICT (workspace_id, site_id, subject, request_id)
        DO UPDATE SET request_id = EXCLUDED.request_id
        RETURNING id, fingerprint, rows, source, filename, created_at AS "createdAt"
      `);
      if (!batch) return reply.code(404).send({ message: '找不到此推广站点。' });
      if (batch.fingerprint !== fingerprint) {
        return reply.code(409).send({ message: '这次导入已确认，请重新预览后再提交。' });
      }
      return publicBatch(batch);
    });

    api.get(siteRoute, async (request, reply) => {
      const params = siteParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ message: '站点参数无效。' });
      const { workspaceId, siteId } = params.data;
      return db.query(sql`
        SELECT b.id, b.source, b.filename, b.created_at AS "createdAt", jsonb_array_length(b.rows) AS "rowCount"
        FROM import_batches b JOIN workspace_members m ON m.workspace_id = b.workspace_id
        WHERE b.workspace_id = ${workspaceId} AND b.site_id = ${siteId} AND m.subject = ${identities.get(request)!}
        ORDER BY b.created_at DESC LIMIT 50
      `);
    });

    api.get(`${siteRoute}/:batchId`, async (request, reply) => {
      const params = batchParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ message: '批次参数无效。' });
      const { workspaceId, siteId, batchId } = params.data;
      const [batch] = await db.query<BatchRow>(sql`
        SELECT b.id, b.fingerprint, b.rows, b.source, b.filename, b.created_at AS "createdAt"
        FROM import_batches b JOIN workspace_members m ON m.workspace_id = b.workspace_id
        WHERE b.id = ${batchId} AND b.workspace_id = ${workspaceId} AND b.site_id = ${siteId}
          AND m.subject = ${identities.get(request)!}
      `);
      return batch ? publicBatch(batch) : reply.code(404).send({ message: '找不到导入批次。' });
    });
  }, { prefix: '/api' });
  return app;
}
