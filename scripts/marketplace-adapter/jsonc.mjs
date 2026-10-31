// Small JSONC helpers (JSON with comments and trailing commas). No dependencies.

// Remove comments and trailing commas. Text inside strings is never changed.
export function stripJsonc(text) {
  let out = ''; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') { // copy a whole string
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2;
    } else { out += c; i++; }
  }
  return out;
}

export const parseJsonc = (text) => JSON.parse(stripTrailingCommas(stripJsonc(text)));

// Trailing commas are removed outside of strings only.
function stripTrailingCommas(text) {
  let out = ''; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === ',') {
      let j = i + 1; while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') i++; else { out += c; i++; }
    } else { out += c; i++; }
  }
  return out;
}

// Remove the entry `name` from the "mcp" object (directly or inside mcp.servers) and keep everything else:
// comments, other entries, formatting. Returns the new text, or null if the entry is not found or the result
// cannot be verified. The caller must not write a file when the result is null.
export function jsoncRemoveServer(text, name) {
  let i = 0; let hit = null;
  const ws = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; }
      else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; }
      else return;
    }
  };
  const str = () => { const s = i + 1; i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; return text.slice(s, i - 1); };
  const val = (p) => {
    ws();
    if (text[i] === '{') {
      i++;
      for (;;) {
        ws();
        if (i >= text.length) return;
        if (text[i] === '}') { i++; return; }
        if (text[i] === ',') { i++; continue; }
        const ks = i; const key = str(); ws(); i++; // skip ':'
        val([...p, key]);
        const where = p.join('.');
        if (!hit && key === name && (where === 'mcp.servers' || (where === 'mcp' && key !== 'servers'))) hit = { s: ks, e: i, where };
      }
    } else if (text[i] === '[') {
      i++;
      for (;;) { ws(); if (i >= text.length) return; if (text[i] === ']') { i++; return; } if (text[i] === ',') { i++; continue; } val([...p, '[]']); }
    } else if (text[i] === '"') str();
    else while (i < text.length && !/[,}\]\s/]/.test(text[i])) i++;
  };
  try { val([]); } catch { return null; }
  if (!hit) return null;
  let { s, e } = hit;
  let j = e; while (/[ \t]/.test(text[j] || '')) j++;
  if (text[j] === ',') e = j + 1; // the entry has a comma after it: remove it
  else { let k = s - 1; while (k >= 0 && /\s/.test(text[k])) k--; if (text[k] === ',') s = k; } // last entry: remove the comma before it
  let a = s; while (a > 0 && /[ \t]/.test(text[a - 1])) a--;
  let b = e; while (/[ \t]/.test(text[b] || '')) b++;
  if ((a === 0 || text[a - 1] === '\n') && text[b] === '\n') { s = a; e = b + 1; } // remove the whole line
  const out = text.slice(0, s) + text.slice(e);
  try { // verify: same data as before, minus the entry
    const before = parseJsonc(text); const after = parseJsonc(out);
    if (hit.where === 'mcp.servers') delete before.mcp.servers[name]; else delete before.mcp[name];
    return JSON.stringify(before) === JSON.stringify(after) ? out : null;
  } catch { return null; }
}
