import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  formTemplateLookupSchema,
  formTemplateSaveSchema,
  type FormTemplateBinding,
  type FormTemplateLookup,
} from '@urlput/contracts';
import { normalizeUrl } from '@urlput/import';
import type { Database } from './database.ts';

const workspaceParams = z.object({ workspaceId: z.uuid() });

type Template = {
  version: string;
  origin: string;
  bindings: FormTemplateBinding[];
};

function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareNames(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function templateKey(input: FormTemplateLookup) {
  const pageUrl = normalizeUrl(input.pageUrl);
  const actionUrl = normalizeUrl(input.form.actionUrl);
  if (!pageUrl || !actionUrl) return;
  let locale: string;
  try {
    [locale] = Intl.getCanonicalLocales(input.locale);
  } catch {
    return;
  }
  const fields = input.form.fields.map(field => ({
    ...field,
    options: [...new Set(field.options)].sort(compareNames),
  })).sort((left, right) => compareNames(left.name, right.name));
  const origin = new URL(pageUrl).origin;
  const action = new URL(actionUrl);
  if (origin.length > 512 || action.origin.length > 512) return;
  // Ignore page paths and origin-local action paths. The browser uses the current form.
  const formShape = { revision: 1, actionOrigin: action.origin, method: input.form.method, fields };
  return { origin, locale, entryType: input.entryType, formShape, formFingerprint: fingerprint(formShape) };
}

export function registerFormTemplates(
  api: FastifyInstance,
  db: Database,
  subjectOf: (request: FastifyRequest) => string,
) {
  const path = '/workspaces/:workspaceId/form-templates';
  api.post(`${path}/lookup`, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const body = formTemplateLookupSchema.safeParse(request.body);
    const key = body.success ? templateKey(body.data) : undefined;
    if (!params.success || !key) return reply.code(400).send({ message: '表单摘要无效。' });

    const [membership] = await db.query<{ template: Template | null }>(sql`
      SELECT (
        SELECT jsonb_build_object('version', t.version::text, 'origin', t.origin, 'bindings', t.bindings)
        FROM form_templates t
        WHERE t.workspace_id = m.workspace_id AND t.origin = ${key.origin}
          AND t.entry_type = ${key.entryType} AND t.locale = ${key.locale}
          AND t.form_fingerprint = ${key.formFingerprint}
        ORDER BY t.version DESC LIMIT 1
      ) AS template
      FROM workspace_members m
      WHERE m.workspace_id = ${params.data.workspaceId} AND m.subject = ${subjectOf(request)}
    `);
    if (!membership) return reply.code(404).send({ message: '找不到工作空间。' });
    return membership;
  });

  api.post(path, async (request, reply) => {
    const params = workspaceParams.safeParse(request.params);
    const body = formTemplateSaveSchema.safeParse(request.body);
    const key = body.success ? templateKey(body.data) : undefined;
    if (!params.success || !body.success || !key) return reply.code(400).send({ message: '填写模板无效。' });

    const bindings = [...body.data.bindings].sort((left, right) => compareNames(left.field, right.field));
    const bindingsFingerprint = fingerprint(bindings);
    const [template] = await db.query<Template>(sql`
      INSERT INTO form_templates (workspace_id, origin, entry_type, locale, form_fingerprint, form_shape, bindings_fingerprint, bindings)
      SELECT m.workspace_id, ${key.origin}, ${key.entryType}, ${key.locale}, ${key.formFingerprint},
        ${JSON.stringify(key.formShape)}::jsonb, ${bindingsFingerprint}, ${JSON.stringify(bindings)}::jsonb
      FROM workspace_members m
      WHERE m.workspace_id = ${params.data.workspaceId} AND m.subject = ${subjectOf(request)}
      ON CONFLICT (workspace_id, origin, entry_type, locale, form_fingerprint, bindings_fingerprint)
      DO UPDATE SET bindings_fingerprint = EXCLUDED.bindings_fingerprint
      RETURNING version::text, origin, bindings
    `);
    if (!template) return reply.code(404).send({ message: '找不到工作空间。' });
    return { template };
  });
}
