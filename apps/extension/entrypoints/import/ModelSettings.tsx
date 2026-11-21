import { useEffect, useState } from 'react';
import { requestServiceAccess } from '../../lib/api';
import { defaults, loadModels, profileKey, saveModel, testModel, validateProfile, type Provider } from '../../lib/models';

export function ModelSettings() {
  const [profiles, setProfiles] = useState(defaults);
  const [provider, setProvider] = useState<Provider>('local');
  const [key, setKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    void loadModels().then(async ({ profiles, active }) => {
      setProfiles(profiles);
      setProvider(active);
      setKey(await profileKey(active, profiles[active].endpoint));
    }).catch(() => setMessage('无法读取模型配置。')).finally(() => setBusy(false));
  }, []);

  const profile = profiles[provider];

  async function switchProvider(value: Provider) {
    setProvider(value);
    setKey('');
    setMessage('');
    setBusy(true);
    try {
      setKey(await profileKey(value, profiles[value].endpoint));
    } catch {
      setMessage('无法读取当前会话的模型密钥。');
    } finally {
      setBusy(false);
    }
  }

  async function apply(runTest: boolean) {
    setBusy(true);
    setMessage('');
    try {
      const validated = validateProfile(profile);
      if (runTest) {
        if (!(await requestServiceAccess(validated.endpoint))) throw new Error('未授权访问该模型服务。');
        await testModel(validated, key);
        setMessage('连接成功。若要保留设置，请点击保存。');
      } else {
        await saveModel(validated, key);
        setProfiles(previous => ({ ...previous, [provider]: validated }));
        setMessage('模型设置已保存。密钥只在本次浏览器会话保留。');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>AI 模型</h2>
      <p>兼容 OpenAI Chat Completions。连接测试只发送固定测试消息。分析与文案开关将用于后续功能。</p>
      <fieldset disabled={busy} className="stack">
        <label>服务类型<select value={provider} onChange={event => void switchProvider(event.target.value as Provider)}>
          <option value="local">本地模型</option><option value="custom">自建模型服务</option>
        </select></label>
        <label>API 基础地址<input type="url" placeholder="https://models.example.com/v1" value={profile.endpoint} onChange={event => {
          const endpoint = event.target.value;
          setProfiles({ ...profiles, [provider]: { ...profile, endpoint } });
          setKey('');
        }} /></label>
        <label>模型名称<input value={profile.model} onChange={event => setProfiles({ ...profiles, [provider]: { ...profile, model: event.target.value } })} /></label>
        <label>API 密钥（需要时填写）<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} /></label>
        <div className="controls">
          <label className="inline"><input type="checkbox" checked={profile.analysis} onChange={event => setProfiles({ ...profiles, [provider]: { ...profile, analysis: event.target.checked } })} /> 启用分析</label>
          <label className="inline"><input type="checkbox" checked={profile.writing} onChange={event => setProfiles({ ...profiles, [provider]: { ...profile, writing: event.target.checked } })} /> 启用文案</label>
        </div>
        <div className="controls">
          <button onClick={() => void apply(false)}>保存设置</button>
          <button className="secondary" onClick={() => void apply(true)}>测试连接</button>
        </div>
      </fieldset>
      <div role="status">{message}</div>
    </section>
  );
}
