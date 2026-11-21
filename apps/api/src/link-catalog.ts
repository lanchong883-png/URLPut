import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { normalizeUrl } from '@urlput/import';
import type { Database } from './database.ts';

const workspaceParams = z.object({ workspaceId: z.uuid() });
const catalogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).safe().default(0),
  q: z.string().trim().max(200).default(''),
});
const observationSchema = z.object({
  url: z.string().max(8192),
  status: z.enum(['active', 'inactive']),
  observedAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(512).optional(),
});

type LinkRecord = {
  url: string;
  origin: string;
  status: 'active' | 'inactive';
  observedAt: string;
  reason: string | null;
};

export function registerLinkCatalog(
  api: FastifyInstance,
  db: Database,
  subjectOf: (request: FastifyRequest) => string,
) {
  const path = '/workspaces/:workspaceId/link-catalog';
  for (const due of [false, true]) {
    api.get(due ? `${path}/recheck` : path, async (request, reply) => {
      const params = workspaceParams.safeParse(request.params);
      const query = catalogQuery.safeParse(request.query);
      if (!params.success || !query.success) return reply.code(400).send({ message: '清单参数无效。' });
      const { limit, offset, q } = query.data;
      const eligibility = due
        ? sql`l.observed_at <= now() - interval '7 days'`
        : sql`l.status = 'active' AND l.observed_at > now() - interval '30 days'`;
      const sort = due ? sql`l.observed_at ASC` : sql`l.observed_at DESC`;
      const [membership] = await db.query<{ links: LinkRecord[] }>(sql`
        SELECT ARRAY(
          SELECT jsonb_build_object('url', l.normalized_url, 'origin', l.origin,
            'status', l.status, 'observedAt', l.observed_at, 'reason', l.reason)
          FROM external_link_catalog l
          WHERE l.workspace_id = m.workspace_id AND ${eligibility}
            AND (${q} = '' OR strpos(lower(l.normalized_url), lower(${q})) > 0)
          ORDER BY ${sort}, l.url_fingerprint
          LIMIT ${limit + 1} OFFSET ${offset}
        ) AS links
        FROM workspace_members m
        WHERE m.workspace_id = ${params.data.workspaceId} AND m.subject = ${subjectOf(request)}
      `);
      if (!membership) return reply.code(404).send({ message: '找不到工作空间。' });
      return {
        links: membership.links.slice(0, limit),
        nextOffset: membership.links.length > limit ? offset + limit : null,
      };
    });
  }

  api.post(`${path}/observations`, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const body = observationSchema.safeParse(request.body);
    const url = body.success ? normalizeUrl(body.data.url) : undefined;
    if (!params.success || !body.success || !url) {
      return reply.code(400).send({ message: '外链检查结果无效。' });
    }
    const observedAt = new Date(body.data.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt.getTime() > Date.now()) {
      return reply.code(400).send({ message: '外链检查时间无效。' });
    }
    const { status, reason } = body.data;
    const urlFingerprint = createHash('sha256').update(url).digest('hex');
    const [membership] = await db.query<{ saved: boolean }>(sql`
      WITH member AS (
        SELECT workspace_id FROM workspace_members
        WHERE workspace_id = ${params.data.workspaceId} AND subject = ${subjectOf(request)}
      ), updated AS (
        INSERT INTO external_link_catalog (workspace_id, url_fingerprint, normalized_url, origin, status, observed_at, reason)
        SELECT workspace_id, ${urlFingerprint}, ${url}, ${new URL(url).origin}, ${status},
          ${observedAt.toISOString()}::timestamptz, ${reason ?? null}
        FROM member
        ON CONFLICT (workspace_id, url_fingerprint) DO UPDATE
        SET status = EXCLUDED.status, observed_at = EXCLUDED.observed_at, reason = EXCLUDED.reason
        WHERE external_link_catalog.normalized_url = EXCLUDED.normalized_url
          AND (external_link_catalog.observed_at < EXCLUDED.observed_at
          OR (external_link_catalog.observed_at = EXCLUDED.observed_at
              AND external_link_catalog.status = 'active' AND EXCLUDED.status = 'inactive'))
        RETURNING 1
      )
      SELECT EXISTS (SELECT 1 FROM updated) AS saved FROM member
    `);
    if (!membership) return reply.code(404).send({ message: '找不到工作空间。' });
    return membership;
  });
}
