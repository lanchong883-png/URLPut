import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { ImportWorkbench } from '../../components/ImportWorkbench';
import { ModelSettings } from '../import/ModelSettings';
import '../import/style.css';
import './style.css';

const pages = [
  { id: 'setup', label: '新建批次', icon: 'M8 2v12M2 8h12', disabled: true },
  { id: 'tasks', label: '任务', icon: 'M6 4h8M6 8h8M6 12h8M2 4h1M2 8h1M2 12h1', disabled: true },
  { id: 'library', label: '清单', icon: 'M1.5 4h5l1.5 2h6.5v7h-13z' },
  { id: 'templates', label: '内容模板', icon: 'M4 2h8v12H4zM6 6h4M6 9h4', disabled: true },
  { id: 'models', label: 'AI 模型', icon: 'M8 1.5 9.7 6l4.8 2-4.8 2L8 14.5 6.3 10 1.5 8l4.8-2z' },
  { id: 'auth', label: '认证方式', icon: 'M9 7a3.5 3.5 0 1 0 0-5 3.5 3.5 0 0 0 0 5Zm0 0-6 6m2-2 2 2', disabled: true },
] as const;

function SidePanel() {
  const [view, setView] = useState<'library' | 'models'>('library');

  return <div className="side-panel">
    <header className="panel-header">
      <div className="panel-bar">
        <div className="panel-brand"><span aria-hidden="true" />URLPut</div>
        <button className="secondary open-workbench" onClick={() => void browser.tabs.create({ url: new URL('/import.html', location.href).href })}>
          打开工作台
        </button>
      </div>
      <nav aria-label="插件导航">
        {pages.map(page => <button key={page.id} disabled={'disabled' in page} aria-current={view === page.id ? 'page' : undefined}
          onClick={() => { if (!('disabled' in page)) setView(page.id); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d={page.icon} /></svg>
          {page.label}
        </button>)}
      </nav>
    </header>
    <main className="panel-content">
      <div hidden={view !== 'library'}>
        <h1>清单</h1>
        <ImportWorkbench withCatalog />
      </div>
      {view === 'models' && <ModelSettings />}
    </main>
  </div>;
}

createRoot(document.getElementById('app')!).render(<SidePanel />);
