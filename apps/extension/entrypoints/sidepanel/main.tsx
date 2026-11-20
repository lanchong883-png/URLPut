import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import '../import/style.css';

createRoot(document.getElementById('app')!).render(
  <main className="shell">
    <div className="brand">URLPut</div>
    <h1>外链工作台</h1>
    <p>导入候选网址并查看逐行结果。</p>
    <button onClick={() => void browser.tabs.create({ url: new URL('/import.html', location.href).href })}>打开工作台</button>
  </main>,
);
