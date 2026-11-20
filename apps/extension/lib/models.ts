import { browser } from 'wxt/browser';

export type Provider = 'local' | 'custom';
export type ModelProfile = {
  provider: Provider;
  endpoint: string;
  model: string;
  analysis: boolean;
  writing: boolean;
};

export const defaults: Record<Provider, ModelProfile> = {
  local: { provider: 'local', endpoint: 'http://127.0.0.1:11434/v1', model: '', analysis: false, writing: false },
  custom: { provider: 'custom', endpoint: '', model: '', analysis: false, writing: false },
};

const profilesKey = 'modelProfiles';
const activeKey = 'activeModelProvider';

export function validateProfile(profile: ModelProfile) {
  const endpoint = new URL(profile.endpoint.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('请使用 HTTPS 地址，或填写本机 HTTP 地址。地址中不能包含凭证、查询参数或片段。');
  }
  if (!profile.model.trim() || profile.model.length > 200) throw new Error('请输入模型名称。');
  return { ...profile, endpoint: endpoint.href.replace(/\/+$/, ''), model: profile.model.trim() };
}

export async function loadModels() {
  const result = await browser.storage.local.get([profilesKey, activeKey]);
  return {
    profiles: { ...defaults, ...result[profilesKey] as Partial<Record<Provider, ModelProfile>> },
    active: (result[activeKey] === 'custom' ? 'custom' : 'local') as Provider,
  };
}

export async function saveModel(profile: ModelProfile, key: string) {
  const { profiles } = await loadModels();
  const keyName = `modelKey:${profile.provider}`;
  if (key.trim()) await browser.storage.session.set({ [keyName]: { endpoint: profile.endpoint, value: key.trim() } });
  else await browser.storage.session.remove(keyName);
  await browser.storage.local.set({ [profilesKey]: { ...profiles, [profile.provider]: profile }, [activeKey]: profile.provider });
}

export async function profileKey(provider: Provider, endpoint: string) {
  const key = `modelKey:${provider}`;
  const record = (await browser.storage.session.get(key))[key] as { endpoint: string; value: string } | undefined;
  return record && record.endpoint === endpoint ? record.value : '';
}

export async function testModel(profile: ModelProfile, key: string) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (key.trim()) headers.set('Authorization', `Bearer ${key.trim()}`);
  const response = await fetch(`${profile.endpoint}/chat/completions`, {
    method: 'POST',
    headers,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model: profile.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}。请检查地址、模型名和密钥。`);
  const result = await response.json();
  if (!Array.isArray(result.choices) || !result.choices.some((choice: { message?: { content?: unknown } }) =>
    typeof choice?.message?.content === 'string' && choice.message.content.trim())) {
    throw new Error('响应中没有可用的文本结果，请检查服务是否支持 OpenAI Chat Completions。');
  }
}
