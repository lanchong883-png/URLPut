import type { Workspace } from '@urlput/contracts';
import type { DraftConfig, DraftTemplate } from '../lib/draft-config';

export function BatchDraftSettings({ config, templates, sites, onChange }: {
  config: DraftConfig;
  templates: DraftTemplate[];
  sites: Workspace['sites'];
  onChange: (config: DraftConfig) => void;
}) {
  return <>
    <section className="card stack">
      <h2>4 投稿内容</h2>
      <label>草稿策略<select value={config.strategy} onChange={event =>
        onChange({ ...config, strategy: event.target.value as DraftConfig['strategy'] })}>
        <option value="template">从内容模板选择</option>
        <option value="ai">AI 拟写</option>
        <option value="mixed">AI 分析 + 模板</option>
      </select></label>
      {config.strategy !== 'ai' && templates.map(template => <label key={template.id} className="inline">
        <input type="checkbox" checked={config.templates.some(item => item.id === template.id)} onChange={event =>
          onChange({ ...config, templates: event.target.checked ? [...config.templates, template] : config.templates.filter(item => item.id !== template.id) })} />
        {template.category} · {template.name}
      </label>)}
      {config.strategy !== 'ai' && !config.templates.length && <p>请至少选一份内容模板。</p>}
    </section>
    <section className="card stack">
      <h2>5 认证与二次确认</h2>
      <p>每条草稿均需人工批准。登录、验证和发表由用户在目标站点完成。</p>
    </section>
    <section className="card stack">
      <h2>6 提交频率</h2>
      <label>每站滚动 24 小时额度<input type="number" min={1} max={5000} value={config.dailyLimit || ''} onChange={event =>
        onChange({ ...config, dailyLimit: event.target.valueAsNumber || 0 })} /></label>
      {sites.map(site => <label key={site.id}>{site.name} · 单站额度<input type="number" min={1} max={5000}
        value={config.siteLimits[site.id] ?? ''} placeholder="使用默认值" onChange={event => {
          const siteLimits = { ...config.siteLimits };
          if (event.target.value) siteLimits[site.id] = event.target.valueAsNumber;
          else delete siteLimits[site.id];
          onChange({ ...config, siteLimits });
        }} /></label>)}
      <label className="inline"><input type="checkbox" checked={config.automaticNextRound} onChange={event =>
        onChange({ ...config, automaticNextRound: event.target.checked })} />额度恢复时更新可继续状态</label>
    </section>
  </>;
}
