import { notifySubmissionReviewChanged } from './review-events';
import { checkPage, checkSegmentSize } from './check-queue';
import { generateModelDraft, type ModelProfile } from './models';
import { read, write, directoryWritesLock, type MultiSiteBatch } from './local-directory';

const templateFile = 'local-draft-templates.json';

export type DraftTemplate = {
  id: string;
  revision: number;
  category: string;
  name: string;
  body: string;
};

export type DraftConfig = {
  strategy: 'template' | 'ai' | 'mixed';
  templates: DraftTemplate[];
  dailyLimit: number;
  siteLimits: Record<string, number>;
  automaticNextRound: boolean;
  model?: ModelProfile;
};

export const defaultDraftTemplates: DraftTemplate[] = [
  { id: 'directory-intro', revision: 1, category: '目录收录', name: '站点简介', body: '{{站点名称}}的网站地址为 {{站点网址}}。' },
  { id: 'community-resource', revision: 1, category: '社区推荐', name: '资源推荐', body: '分享一个可参考的资源：{{站点名称}}（{{站点网址}}）。' },
  { id: 'general-intro', revision: 1, category: '通用文案', name: '官网导览', body: '了解 {{站点名称}}：{{站点网址}}。' },
];

export async function draftTemplates(dir: FileSystemDirectoryHandle) {
  return await read<DraftTemplate[]>(dir, templateFile) ?? defaultDraftTemplates;
}

export function saveDraftTemplate(dir: FileSystemDirectoryHandle, template: DraftTemplate) {
  return navigator.locks.request(directoryWritesLock, async () => {
    if (!template.name.trim() || !template.category.trim() || !template.body.trim() || template.body.length > 5000) {
      throw new Error('请填写模板名称、分类及 1–5,000 字的内容。');
    }
    const templates = [...await draftTemplates(dir)];
    const index = templates.findIndex(item => item.id === template.id);
    if (index >= 0) {
      if (templates[index].revision !== template.revision) throw new Error('模板已更新，请重新读取后编辑。');
      templates[index] = { ...template, revision: template.revision + 1 };
    } else templates.push({ ...template, revision: 1 });
    await write(dir, templateFile, templates);
    return templates;
  });
}

export function renderDraftTemplate(template: DraftTemplate, site: { name: string; homepage: string }) {
  return template.body.replace(/\{\{站点名称\}\}/g, () => site.name)
    .replace(/\{\{站点网址\}\}/g, () => site.homepage);
}

type SavedDraft = { body: string; source: string; at: string };

function draftsFile(batch: string, site: string) {
  return `multi-drafts-${batch}-${site}.json`;
}

export async function batchDrafts(dir: FileSystemDirectoryHandle, batch: string, site: string) {
  return await read<Record<string, SavedDraft>>(dir, draftsFile(batch, site)) ?? {};
}

type DraftBlocker = { batch: string; sequence: number; entry: string; reason: string };

export async function draftBlockers(dir: FileSystemDirectoryHandle, site: string) {
  return await read<Record<string, DraftBlocker>>(dir, `draft-blockers-${site}.json`) ?? {};
}

function updateDraftBlocker(dir: FileSystemDirectoryHandle, site: string, batch: string, sequence: number, blocker?: DraftBlocker) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const blockers = await draftBlockers(dir, site);
    const key = `${batch}:${sequence}`;
    if (blocker) blockers[key] = blocker;
    else if (blockers[key]) delete blockers[key];
    else return;
    await write(dir, `draft-blockers-${site}.json`, blockers);
    notifySubmissionReviewChanged();
  });
}

export function prepareBatchDraft(dir: FileSystemDirectoryHandle, batch: MultiSiteBatch, siteId: string, sequence: number) {
  return navigator.locks.request(`urlput-draft-${batch.id}-${siteId}-${sequence}`, async () => {
    const site = batch.sites.find(item => item.id === siteId);
    const config = batch.execution;
    const row = batch.input.rows[sequence - 1];
    try {
      const saved = (await batchDrafts(dir, batch.id, siteId))[sequence];
      if (saved) {
        await updateDraftBlocker(dir, siteId, batch.id, sequence);
        return saved;
      }
      if (!site || !config || !row) throw new Error('找不到该条的已保存执行配置。');
      const page = await checkPage(dir, { site: siteId, batch: batch.id, analysis: true }, Math.floor((sequence - 1) / checkSegmentSize));
      const result = page.find(item => item.sequence === sequence);
      if (!result?.ok || !result.analysis) throw new Error('待确认：该条尚无成功的分析结果。');
      const analysis = result.analysis;
      if (/登录|验证/.test(analysis.login) && !/未发现|未检测|无需|未知/.test(analysis.login)) {
        throw new Error('待确认：请在目标站点核对登录和验证要求。');
      }
      const template = config.templates.find(item => analysis.category.includes(item.category)) ??
        config.templates.find(item => item.category === '通用文案') ?? config.templates[0];
      if (config.strategy !== 'ai' && !template) throw new Error('待确认：当前批次没有可用模板。');
      const seed = template && config.strategy !== 'ai' ? renderDraftTemplate(template, site) : undefined;
      const version = template ? `${template.name} v${template.revision}` : '';
      let body: string;
      let source: string;
      if (config.strategy === 'template' && seed) { body = seed; source = version; }
      else {
        if (!config.model) throw new Error('待确认：启动时未配置启用文案的模型。');
        if (!analysis.title) throw new Error('待确认：缺少足够的目标页资料。');
        body = await generateModelDraft(config.model, {
          site: { name: site.name, homepage: site.homepage }, target: row.url,
          title: analysis.title, category: analysis.category, required: analysis.required, seed,
        });
        source = [config.model.model, seed ? version : ''].filter(Boolean).join(' + ');
      }
      const entry = { body, source, at: new Date().toISOString() };
      await navigator.locks.request(directoryWritesLock, async () => {
        const drafts = await batchDrafts(dir, batch.id, siteId);
        drafts[sequence] = entry;
        await write(dir, draftsFile(batch.id, siteId), drafts);
      });
      await updateDraftBlocker(dir, siteId, batch.id, sequence);
      return entry;
    } catch (failure) {
      if (row) {
        const reason = failure instanceof Error ? failure.message : '草稿无法准备，请人工核对。';
        await updateDraftBlocker(dir, siteId, batch.id, sequence, {
          batch: batch.id, sequence, entry: row.entry || row.url, reason,
        }).catch(() => { /* Preserve the original failure if the directory is unavailable. */ });
      }
      throw failure;
    }
  });
}
