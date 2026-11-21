import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImportWorkbench } from '../../components/ImportWorkbench';
import { ModelSettings } from './ModelSettings';
import './style.css';

function App() {
  const [view, setView] = useState<'import' | 'models'>('import');

  return <main className="shell">
    <header className="top">
      <div><div className="brand">URLPut</div><h1>外链工作台</h1></div>
      <nav className="controls">
        <button className={view === 'import' ? '' : 'secondary'} onClick={() => setView('import')}>导入与台账</button>
        <button className={view === 'models' ? '' : 'secondary'} onClick={() => setView('models')}>AI 设置</button>
      </nav>
    </header>
    <div hidden={view !== 'import'}><ImportWorkbench /></div>
    {view === 'models' && <ModelSettings />}
  </main>;
}

createRoot(document.getElementById('app')!).render(<App />);
