// A pragmatic scanner for backdrop clicks that close an overlay without
// backdropDismiss() (src/ui/backdropDismiss.js). Used by backdropGuard.test.js.
//
// It is not a JSX parser. It finds JSX opening tags (`<div ...>`) by walking
// the source with brace / string / comment tracking, and reports a tag when:
//   - it looks like an overlay: `fixed`, `inset-0`, `position: 'fixed'` or
//     `inset: 0` appears in the tag, and
//   - it has its own `onClick=` whose handler does more than
//     stopPropagation()/preventDefault() (a panel swallowing clicks is fine).
// Buttons and links are skipped: a click on a control is not a backdrop.

import fs from 'node:fs';
import path from 'node:path';

const OVERLAY_RE = /\bfixed\b|\binset-0\b|position:\s*['"]fixed['"]|\binset:\s*0\b/;
const CONTROL_TAGS = /^(button|Button|IconButton|SbButton|a|input|select|label|Link)$/;
// `{(e) => e.stopPropagation()}`, `{(e) => { e.stopPropagation(); e.preventDefault() }}`, `{stop}`...
const SWALLOW_ONLY_RE = /^\{\s*(?:\(\s*e?\s*\)|e)\s*=>\s*\{?\s*(?:e\.(?:stopPropagation|preventDefault)\(\)\s*;?\s*)+\}?\s*\}$/;

/** Opening JSX tags in `src`: [{ name, text, line, attrs: [{ name, value }] }]. */
export function jsxOpeningTags(src) {
  const tags = [];
  const n = src.length;
  let i = 0;
  // Skip over JS strings / comments / template literals at the top level so a
  // `<` inside them is not taken for a tag.
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '<' && /[A-Za-z]/.test(src[i + 1] || '') && isTagStart(src, i)) {
      const tag = readTag(src, i);
      if (tag) { tags.push(tag); i = tag.end; continue; }
    }
    i += 1;
  }
  return tags;
}

function isTagStart(src, i) {
  let j = i - 1;
  for (;;) {
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    if (j < 0) return true;
    // Look past comments between `(` / `return` and the tag.
    if (src[j] === '/' && src[j - 1] === '*') {
      const open = src.lastIndexOf('/*', j - 2);
      if (open < 0) break;
      j = open - 1;
      continue;
    }
    const lineStart = src.lastIndexOf('\n', j) + 1;
    if (/^\s*\/\//.test(src.slice(lineStart, j + 1))) { j = lineStart - 1; continue; }
    break;
  }
  if (j < 0) return true;
  const prev = src[j];
  if ('(>{}?:,=&|['.includes(prev)) return true;
  return /\breturn$/.test(src.slice(Math.max(0, j - 6), j + 1));
}

// Skip a JS string / template / comment starting at `i`; returns the index after it, or -1 if none.
function skipJs(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e; }
  if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  if (c === '"' || c === "'" || c === '`') {
    let j = i + 1;
    while (j < src.length && src[j] !== c) { if (src[j] === '\\') j += 1; j += 1; }
    return j + 1;
  }
  return -1;
}

function readTag(src, start) {
  const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(start, start + 80));
  if (!m) return null;
  const name = m[1];
  let i = start + m[0].length;
  const attrs = [];
  const limit = Math.min(src.length, start + 20000);
  while (i < limit) {
    while (i < limit && /\s/.test(src[i])) i += 1;
    const c = src[i];
    if (c === '>') { i += 1; break; }
    if (c === '/' && src[i + 1] === '>') { i += 2; break; }
    if (c === '{') { // spread attribute `{...x}`
      const end = readBraces(src, i);
      attrs.push({ name: '...', value: src.slice(i, end) });
      i = end;
      continue;
    }
    const am = /^([\w:-]+)/.exec(src.slice(i, i + 80));
    if (!am) return null; // not a tag after all
    i += am[1].length;
    let value = '';
    if (src[i] === '=') {
      i += 1;
      if (src[i] === '"' || src[i] === "'") { const e = skipJs(src, i); value = src.slice(i, e); i = e; }
      else if (src[i] === '{') { const e = readBraces(src, i); value = src.slice(i, e); i = e; }
      else return null;
    }
    attrs.push({ name: am[1], value });
  }
  const line = src.slice(0, start).split('\n').length;
  return { name, attrs, line, text: src.slice(start, i), end: i };
}

function readBraces(src, i) {
  let depth = 0;
  while (i < src.length) {
    const skip = skipJs(src, i);
    if (skip >= 0) { i = skip; continue; }
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return i;
}

/** Overlay tags in `src` that close on a bare onClick. */
export function findBareBackdropClicks(src) {
  const hits = [];
  for (const tag of jsxOpeningTags(src)) {
    if (CONTROL_TAGS.test(tag.name)) continue;
    if (!OVERLAY_RE.test(tag.text)) continue;
    const onClick = tag.attrs.find((a) => a.name === 'onClick');
    if (!onClick) continue;
    const value = onClick.value.replace(/\s+/g, ' ').trim();
    if (SWALLOW_ONLY_RE.test(value)) continue;
    hits.push({ line: tag.line, tag: tag.name, onClick: value });
  }
  return hits;
}

/** Every .js/.jsx/.ts/.tsx source file under `dir` (no tests, no node_modules). */
export function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '__tests__') continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(ent.name) && !/\.(test|spec)\./.test(ent.name) && !ent.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
