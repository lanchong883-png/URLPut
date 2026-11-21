export const headings = ['序号', '网站域名', '网站分类', 'URL', '结果类别', '结论', '原因与下一步'];

export function parseCsv(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const endField = () => {
    row.push(field);
    field = '';
    closed = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r' || char === '\n') {
      endRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else if (char === '"' && field === '' && !closed) {
      quoted = true;
    } else {
      if (closed || char === '"') throw new Error('CSV 引号格式错误。');
      field += char;
    }
  }
  if (quoted) throw new Error('CSV 中有未闭合的引号。');
  if (field || row.length || closed) endRow();
  return rows;
}

export function parseText(text) {
  return text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).flatMap((sourceText, index) => {
    if (!sourceText.trim()) return [];
    const tokens = sourceText.match(/https?:\/\/[^\s<>"'`，。；！？、）》】」]+/gi) ?? [];
    const values = tokens.length ? tokens : [sourceText];
    return values.map((value) => ({ cells: [value], sourceRow: index + 1, sourceText }));
  });
}

export function normalizeUrl(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请输入 HTTP 或 HTTPS 地址，且地址中不能包含账号凭据。');
  }
  url.hash = '';
  return url;
}

export function importRows(rows, column, hasHeader, existing, filename) {
  const seen = new Map();
  for (const row of existing) {
    if (row.normalized && !seen.has(row.normalized)) seen.set(row.normalized, row.number);
  }

  return rows.slice(Number(hasHeader)).map((source, index) => {
    const number = existing.length + index + 1;
    const { cells, sourceRow, sourceText } = Array.isArray(source)
      ? { cells: source, sourceRow: index + 1 + Number(hasHeader) }
      : source;
    const raw = cells[column] ?? '';
    const provenance = { number, raw, filename, sourceRow };
    if (sourceText !== undefined) provenance.sourceText = sourceText;
    try {
      const url = normalizeUrl(raw);
      const normalized = url.href;
      const duplicate = seen.get(normalized);
      if (duplicate === undefined) seen.set(normalized, number);
      return {
        ...provenance, normalized, host: url.hostname,
        conclusion: duplicate === undefined ? '待分析' : '已跳过',
        reason: duplicate === undefined ? '已导入，等待入口分析。' : `重复 URL，见序号 ${duplicate}。`
      };
    } catch {
      return { ...provenance, host: '—', conclusion: '输入无效', reason: '请修正原始 HTTP 或 HTTPS 地址。' };
    }
  });
}

export function reportCells(row) {
  return [row.number, row.host, '未识别', row.raw, '未成功', row.conclusion, row.reason];
}

export function exportCsv(rows) {
  const encode = (value) => {
    const cell = String(value);
    const safe = /^[\t\r\n]|^\s*[=+@-]/.test(cell) ? "'" + cell : cell;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  const data = rows.map((row) => [...reportCells(row), row.filename, row.sourceRow, row.sourceText ?? '']);
  return '\uFEFF' + [[...headings, '来源', '源记录行号', '原始文本'], ...data]
    .map((row) => row.map(encode).join(',')).join('\r\n') + '\r\n';
}
