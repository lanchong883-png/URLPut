import { exportCsv, headings, importRows, normalizeUrl, parseCsv, parseText, reportCells } from './ledger.js';

const get = (id) => document.getElementById(id);
const key = 'urlputLedger';
let state = { sites: [] };
let records = [];
let sourceName = '';
const usesColumns = () => ['csv', 'paste-table'].includes(get('source').value);
const hasHeader = () => usesColumns() && get('header').checked;
let previewRevision = 0;
let busy = false;

const selectedSite = () => state.sites.find((site) => site.id === get('sites').value);
const currentRows = () => selectedSite()?.rows ?? [];
const showStatus = (message) => { get('status').textContent = message; };

function tableRow(values, tag) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement(tag);
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}

function render() {
  get('sites').replaceChildren(...state.sites.map((site) => new Option(site.name, site.id)));
  if (state.selectedId) get('sites').value = state.selectedId;
  const rows = currentRows();
  const body = document.createDocumentFragment();
  for (const row of rows) body.append(tableRow(reportCells(row), 'td'));
  document.querySelector('tbody').replaceChildren(body);
  get('count').textContent = `${rows.length} 条原始记录`;
  get('export').disabled = !rows.length;
  get('import').disabled = busy || !selectedSite() || records.length <= Number(hasHeader());
}

async function withStateChange(change) {
  if (busy) return;
  busy = true;
  get('sites').disabled = true;
  render();
  try {
    // Multiple Chrome windows can open this side panel at the same time.
    await navigator.locks.request(key, async () => {
      const stored = await chrome.storage.local.get(key);
      const next = stored[key] ?? { sites: [] };
      const message = change(next);
      await chrome.storage.local.set({ [key]: next });
      state = next;
      showStatus(message);
    });
  } catch (error) {
    showStatus(error.message);
  } finally {
    busy = false;
    get('sites').disabled = false;
    render();
  }
}

async function preview() {
  const revision = ++previewRevision;
  records = [];
  render();
  get('column').replaceChildren();
  get('preview').textContent = '';
  const source = get('source').value;
  const pasted = source.startsWith('paste-');
  const file = get('file').files[0];
  if (!pasted && !file) return;
  try {
    const content = pasted ? get('paste').value : await file.text();
    if (revision !== previewRevision) return;
    sourceName = pasted ? '粘贴' : file.name;
    if (usesColumns()) {
      const delimiter = get('delimiter').value;
      records = parseCsv(content, delimiter === 'tab' ? '\t' : delimiter);
      const width = records.reduce((max, row) => Math.max(max, row.length), 0);
      for (let column = 0; column < width; column++) {
        const label = hasHeader() && records[0][column] ? records[0][column] : `第 ${column + 1} 列`;
        get('column').add(new Option(label, column));
      }
      const urlColumn = hasHeader() ? records[0]?.findIndex((cell) => /^(url|网址|链接)$/i.test(cell.trim())) : 0;
      if (urlColumn >= 0) get('column').value = urlColumn;
    } else {
      records = parseText(content);
    }
    get('preview').textContent = records.slice(0, 4).map((row) => (row.cells ?? row).join(' ｜ ')).join('\n');
    showStatus(records.length > Number(hasHeader()) || !content ? '' : '没有可导入的记录。');
  } catch (error) {
    if (revision === previewRevision) showStatus(error.message);
  }
  render();
}

get('site-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = get('name').value.trim();
  const homepage = get('homepage').value;
  withStateChange((next) => {
    if (!name) throw new Error('请输入站点名称。');
    const url = normalizeUrl(homepage);
    if (next.sites.some((site) => site.homepage === url.href)) throw new Error('这个官网已经添加。');
    const id = crypto.randomUUID();
    next.sites.push({ id, name, homepage: url.href, rows: [] });
    next.selectedId = id;
    return '推广站点已添加。';
  });
});

get('sites').addEventListener('change', (event) => {
  const id = event.target.value;
  withStateChange((next) => {
    next.selectedId = id;
    return '';
  });
});

get('source').addEventListener('change', () => {
  const source = get('source').value;
  const pasted = source.startsWith('paste-');
  get('file-input').hidden = pasted;
  get('paste-input').hidden = !pasted;
  get('mapping').hidden = !usesColumns();
  get('file').value = '';
  get('file').accept = source === 'txt' ? '.txt,text/plain' : '.csv,.tsv,text/csv';
  if (usesColumns()) {
    get('delimiter').value = pasted ? 'tab' : ',';
    get('header').checked = !pasted;
  }
  preview();
});
for (const id of ['file', 'delimiter', 'header']) get(id).addEventListener('change', preview);
get('paste').addEventListener('input', preview);

get('import').addEventListener('click', () => {
  const siteId = selectedSite().id;
  const filename = sourceName;
  const source = records;
  const column = Number(get('column').value);
  const skipHeader = hasHeader();
  withStateChange((next) => {
    const site = next.sites.find(({ id }) => id === siteId);
    const added = importRows(source, column, skipHeader, site.rows, filename);
    site.rows = site.rows.concat(added);
    next.selectedId = siteId;
    return `已导入 ${added.length} 条记录。`;
  });
});

get('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([exportCsv(currentRows())], { type: 'text/csv;charset=utf-8' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = 'URLPut-台账.csv';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector('thead').append(tableRow(headings, 'th'));
try {
  state = (await chrome.storage.local.get(key))[key] ?? { sites: [] };
  render();
} catch (error) {
  showStatus(error.message);
}
