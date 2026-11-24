// The native <select>: one look on every engine.
//
// The owner's report (Match setup in the Linux desktop app, WebKitGTK): the
// kit Selects showed their text pushed down and clipped inside a grey, inset
// box, while the inputs beside them looked fine. Two causes, both guarded here:
//   1. The legacy element rule `select { padding: 8px 10px; line-height: 1.2;
//      text-transform: capitalize }` (styles.css, legacy layer) reached the kit
//      Select, whose classes set no vertical padding or line height: 8 + 8 px
//      of padding in an h-9 box. It also capitalised "Best of 5" to "Best Of 5".
//   2. appearance: auto, so WebKitGTK and Android WebView drew their own
//      menulist with its own theme padding and grey fill.
// The kit Select now carries `ov-select` (tokens.css: appearance none, the
// chevron, no vertical padding) and a line height equal to its inner height;
// every select rule in styles.css skips `.ov-select`.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Select, SELECT_SIZES } from '../Select.jsx';
import { INPUT_SIZES } from '../Input.jsx';
import { sourceFiles } from './backdropScan.js';

const ROOT = path.resolve(__dirname, '../../..'); // escoresheet/frontend
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

afterEach(cleanup);

describe('kit Select', () => {
  it('md: ov-select, the Input md height, centred text, room for the chevron', () => {
    const { getByRole } = render(
      <Select aria-label="Match format" value="5" onChange={() => {}}>
        <option value="5">Best of 5</option>
      </Select>,
    );
    const cls = getByRole('combobox').className.split(/\s+/);
    for (const c of ['ov-select', 'h-9', 'py-0', 'leading-[34px]', 'pl-3', 'pr-8', 'text-sm', 'rounded-lg']) {
      expect(cls).toContain(c);
    }
    expect(cls).not.toContain('capitalize');
  });

  it('lg: h-11 with a 42 px line height', () => {
    const { getByRole } = render(<Select size="lg" aria-label="x" options={[{ value: 'a', label: 'A' }]} />);
    const cls = getByRole('combobox').className.split(/\s+/);
    for (const c of ['ov-select', 'h-11', 'py-0', 'leading-[42px]', 'rounded-xl']) expect(cls).toContain(c);
  });

  it('keeps ov-select when a caller passes its own classes, block and invalid', () => {
    const { getByRole } = render(
      <Select aria-label="x" block invalid className="w-16 text-xs" options={[{ value: 'a', label: 'A' }]} />,
    );
    const el = getByRole('combobox');
    const cls = el.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['ov-select', 'w-16', 'text-xs', 'border-red-400']));
    expect(cls).not.toContain('w-full'); // tailwind-merge: the caller's width wins
    expect(el.getAttribute('aria-invalid')).toBe('true');
  });

  it('an unknown size falls back to md', () => {
    const { getByRole } = render(<Select size="xl" aria-label="x" options={[]} />);
    expect(getByRole('combobox').className).toContain('h-9');
  });

  it('each size is as tall as the Input of the same name, line height = height - 2 px border', () => {
    const px = { 'h-9': 36, 'h-11': 44 };
    for (const size of ['md', 'lg']) {
      const h = SELECT_SIZES[size].match(/\bh-(9|11)\b/)[0];
      expect(INPUT_SIZES[size]).toMatch(new RegExp(`\\b${h}\\b`));
      expect(SELECT_SIZES[size]).toContain(`leading-[${px[h] - 2}px]`);
      expect(SELECT_SIZES[size]).toMatch(/\bpy-0\b/);
    }
  });
});

describe('select CSS', () => {
  // Split a selector list at its top-level commas (not inside :is()/:where()).
  function splitSelectors(list) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of list) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function selectorsOf(css) {
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const sels = [];
    for (const m of noComments.matchAll(/([^{}]+)\{/g)) {
      const prelude = m[1].trim();
      if (!prelude || prelude.startsWith('@')) continue;
      for (const s of splitSelectors(prelude)) {
        const line = noComments.slice(0, m.index).split('\n').length;
        sels.push({ s, line });
      }
    }
    return sels;
  }
  const TARGETS_SELECT = /(^|[\s>+~(,])select(?![\w-])/;

  it('the scanner sees an unscoped select and accepts the scoped forms', () => {
    const css = `select { a: b }\n.x select, .y input { a: b }\nselect:where(:not(.ov-select)) { a: b }\n.r select:where(:not(.ov-select)) { }\n:where(input, select:not(.ov-select)):focus { }\n.coin-toss-select { }`;
    const bad = selectorsOf(css).filter(({ s }) => TARGETS_SELECT.test(s) && !s.includes('.ov-select')).map(({ s }) => s);
    expect(bad).toEqual(['select', '.x select']);
  });

  it('every select rule in the legacy styles.css skips the kit Select (.ov-select)', () => {
    const bad = selectorsOf(read('src/styles.css'))
      .filter(({ s }) => TARGETS_SELECT.test(s) && !s.includes('.ov-select'))
      .map(({ s, line }) => `styles.css:${line} ${s}`);
    expect(bad).toEqual([]);
  });

  it('no stylesheet capitalises select text or brings back the native menulist', () => {
    for (const rel of ['src/styles.css', 'src/tailwind.css', 'src/ui/tokens.css']) {
      const css = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!TARGETS_SELECT.test(m[1]) && !m[1].includes('.ov-select')) continue;
        expect(m[2], `${rel}: ${m[1].trim()}`).not.toMatch(/text-transform:\s*capitalize/);
        expect(m[2], `${rel}: ${m[1].trim()}`).not.toMatch(/appearance:\s*auto/);
      }
    }
  });

  it('tokens.css gives .ov-select appearance none, the chevron and no vertical padding', () => {
    const css = read('src/ui/tokens.css');
    const rule = css.match(/\.ov-select\s*\{([^}]*)\}/)[1];
    expect(rule).toMatch(/(^|\s)appearance:\s*none/);
    expect(rule).toMatch(/-webkit-appearance:\s*none/);
    expect(rule).toMatch(/background-image:\s*url\("data:image\/svg\+xml/);
    expect(rule).toMatch(/padding-block:\s*0/);
    expect(rule).toMatch(/text-transform:\s*none/);
    expect(rule).toMatch(/font-family:\s*inherit/);
  });

  it('.ov-select sits in the components layer (above legacy, below utilities)', () => {
    const css = read('src/ui/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const layer = css.indexOf('@layer components');
    expect(layer).toBeGreaterThan(-1);
    expect(css.indexOf('.ov-select', layer)).toBeGreaterThan(layer);
  });

  it('the legacy select draws the same chevron with appearance none', () => {
    const css = read('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const body = css.match(/(?:^|\})\s*select:where\(:not\(\.ov-select\)\)\s*\{([^}]*)\}/)[1];
    expect(body).toMatch(/(^|[\s;])appearance:\s*none/);
    expect(body).toMatch(/background-image:\s*url\("data:image\/svg\+xml/);
    expect(body).toMatch(/padding-right:[^;]*!important/);
  });
});

describe('select call sites', () => {
  const files = sourceFiles(path.join(ROOT, 'src')).filter((f) => !f.includes(`${path.sep}ui${path.sep}`));

  it('no raw <select> dressed as a kit control (h-9 / h-11 / rounded-lg / rounded-xl): use <Select>', () => {
    const bad = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<select\b[^>]*?className=\{?["'`]?([^"'`}]*)/g)) {
        if (/\b(h-9|h-11|rounded-lg|rounded-xl)\b/.test(m[1])) bad.push(`${path.relative(ROOT, file)}: ${m[1].slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no kit Select capitalizes its labels', () => {
    const bad = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<Select\b[^>]*>/g)) if (/\bcapitalize\b/.test(m[0])) bad.push(path.relative(ROOT, file));
    }
    expect(bad).toEqual([]);
  });
});

describe('option labels', () => {
  // Every i18n key rendered as an <option> (or an options={[{ label: t(...) }]})
  // starts with a capital letter in every locale: sentence case, now that no
  // stylesheet capitalises select text any more.
  const LOCALES = ['en', 'de', 'de-CH', 'fr', 'it'].map((l) => [l, JSON.parse(read(`src/i18n/locales/${l}.json`))]);
  const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);

  function optionKeys() {
    const keys = new Set();
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) { if (!/__tests__|node_modules/.test(p)) walk(p); continue; }
        if (!/\.jsx?$/.test(f)) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const m of src.matchAll(/<option[^>]*>\s*\{\s*t\(\s*['"`]([\w.]+)['"`]/g)) keys.add(m[1]);
      }
    };
    walk(path.join(ROOT, 'src'));
    return keys;
  }

  it('finds the Match setup options', () => {
    const keys = optionKeys();
    for (const k of ['matchSetup.bestOf5', 'matchSetup.championship', 'matchSetup.regional', 'roster.none']) expect(keys).toContain(k);
  });

  it('start with a capital letter in all five locales', () => {
    const bad = [];
    for (const k of optionKeys()) {
      for (const [l, dict] of LOCALES) {
        const v = get(dict, k);
        if (typeof v === 'string' && /^\p{Ll}/u.test(v)) bad.push(`${l} ${k} = ${JSON.stringify(v)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('"Best of 5" / "Best of 3" in sentence case', () => {
    for (const [, dict] of LOCALES) {
      expect(dict.matchSetup.bestOf5).toBe('Best of 5');
      expect(dict.matchSetup.bestOf3).toBe('Best of 3');
    }
  });
});
