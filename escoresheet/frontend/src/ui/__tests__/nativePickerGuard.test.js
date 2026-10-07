// Guard: no native date / time pickers. The WebKitGTK date popup in the Linux
// desktop app could not be closed ("i can't get out of the date picker"), and
// WebKit shows today's date in an EMPTY native date field. Use the kit's
// DateField / TimeField / DateTimeField (src/ui/DateField.jsx) instead: typed
// DD.MM.YYYY / HH:MM with the kit's own popovers, ISO values in and out.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsxOpeningTags, sourceFiles } from './backdropScan.js';

const ROOT = path.resolve(__dirname, '../../..'); // escoresheet/frontend
const NATIVE = /^(date|time|datetime-local|month|week)$/;
// type="date" / type={'date'} / type={cond ? 'date' : 'text'} / type={`time`}
const QUOTED = /['"`](date|time|datetime-local|month|week)['"`]/;
// el.type = 'date', setAttribute('type', 'date'), createElement('input', { type: 'date' })
const IMPERATIVE = /\.type\s*=\s*['"`](?:date|time|datetime-local|month|week)['"`]|setAttribute\(\s*['"]type['"]\s*,\s*['"](?:date|time|datetime-local|month|week)['"]|\btype\s*:\s*['"](?:date|time|datetime-local|month|week)['"]/;

/** Native date/time inputs in one source text: [{ line, text }]. */
export function findNativePickers(src) {
  const hits = [];
  for (const tag of jsxOpeningTags(src)) {
    const type = tag.attrs.find((a) => a.name === 'type');
    if (!type || !type.value) continue;
    const v = type.value.trim();
    const literal = /^['"](.*)['"]$/.exec(v);
    if ((literal && NATIVE.test(literal[1])) || (!literal && QUOTED.test(v))) {
      hits.push({ line: tag.line, text: `<${tag.name} type=${v}>` });
    }
  }
  // Outside JSX, ignoring comments.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/.*$/gm, '$1');
  code.split('\n').forEach((line, i) => {
    if (IMPERATIVE.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 100) });
  });
  return hits;
}

describe('native date/time picker guard', () => {
  it('the scanner finds every form (and ignores comments and the kit fields)', () => {
    const bad = `
      const A = () => <input type="date" value={v} />
      const B = () => <Input type='time' />
      const C = () => <input type={'datetime-local'} />
      const D = () => <input type={wide ? 'date' : 'text'} />
      el.type = 'date'
      const spec = { type: 'time', name: 'x' }
    `;
    expect(findNativePickers(bad).map((h) => h.line)).toEqual([2, 3, 4, 5, 6, 7]);
    const good = `
      // Not <input type="date">: WebKit pre-fills it
      /* <input type="time"> */
      const A = () => <DateField value={v} onChange={setV} />
      const B = () => <input type="text" inputMode="numeric" />
      const C = () => <TimeField step={5} />
      const k = { type: 'text' }
    `;
    expect(findNativePickers(good)).toEqual([]);
  });

  it('no native type=date/time/datetime-local/month/week input in src/ or scoresheet_pdf/', () => {
    const hits = [];
    for (const dir of ['src', 'scoresheet_pdf']) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        for (const hit of findNativePickers(fs.readFileSync(file, 'utf8'))) hits.push(`${rel}:${hit.line} ${hit.text}`);
      }
    }
    expect(hits).toEqual([]);
  }, 60_000);
});
