import { z } from 'zod';

const fieldName = z.string().trim().min(1).max(160).regex(/^[^<>\u0000-\u001f\u007f]+$/u);
const fieldSchema = z.object({
  name: fieldName,
  type: z.enum(['text', 'url', 'email', 'tel', 'textarea', 'select', 'checkbox', 'radio']),
  required: z.boolean(),
  label: z.string().trim().max(256).default(''),
  maxLength: z.number().int().nonnegative().max(1_000_000).nullable().default(null),
  options: z.array(z.string().max(256)).max(100).default([]),
});

export const formTemplateLookupSchema = z.object({
  pageUrl: z.string().max(8192),
  entryType: z.enum(['directory', 'profile', 'comment', 'article', 'url']),
  locale: z.string().trim().min(1).max(35),
  form: z.object({
    actionUrl: z.string().max(8192),
    method: z.enum(['get', 'post']),
    fields: z.array(fieldSchema).min(1).max(100),
  }),
}).superRefine(({ form }, context) => {
  if (new Set(form.fields.map(field => field.name)).size !== form.fields.length) {
    context.addIssue({ code: 'custom', path: ['form', 'fields'], message: 'Field names must be unique.' });
  }
});

const bindingSchema = z.object({
  field: fieldName,
  source: z.enum(['siteName', 'siteUrl', 'contactEmail', 'description', 'title', 'category', 'content']),
});

export const formTemplateSaveSchema = formTemplateLookupSchema.safeExtend({
  bindings: z.array(bindingSchema).min(1).max(100),
}).superRefine(({ form, bindings }, context) => {
  const mapped = new Set(bindings.map(binding => binding.field));
  const fields = new Set(form.fields.map(field => field.name));
  if (mapped.size !== bindings.length || bindings.some(binding => !fields.has(binding.field)) ||
    form.fields.some(field => field.required && !mapped.has(field.name))) {
    context.addIssue({ code: 'custom', path: ['bindings'], message: 'Bindings must reference distinct fields and cover required fields.' });
  }
});

export type FormTemplateLookup = z.infer<typeof formTemplateLookupSchema>;
export type FormTemplateBinding = z.infer<typeof bindingSchema>;
