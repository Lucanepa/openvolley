// Guard: every overlay that closes on a backdrop click goes through
// backdropDismiss() (src/ui/backdropDismiss.js). A bare `onClick={onClose}` on
// a `fixed inset-0` backdrop closes the dialog when a text selection (or any
// drag) that started inside it ends over the backdrop.
//
// The scan is pragmatic (backdropScan.js): a JSX tag that looks like an overlay
// (`fixed`, `inset-0`, `position: 'fixed'`, `inset: 0`) with its own onClick
// that does more than stopPropagation/preventDefault. Replace that onClick with
// `{...backdropDismiss(handler)}`. A fixed element whose click is NOT a dismiss
// (a floating badge, a toast) goes in ALLOWED below with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBareBackdropClicks, sourceFiles } from './backdropScan.js';

const ROOT = path.resolve(__dirname, '../../..'); // escoresheet/frontend

// `relative/path.jsx` -> handler text (whitespace collapsed) that is allowed.
const ALLOWED = {
  // The collapsed "Test mode" badge: a click opens the panel, it is not a backdrop.
  'src/components/TestModeControls.jsx': ['{() => setExpanded(true)}'],
};

function scan() {
  const hits = [];
  for (const dir of ['src', 'scoresheet_pdf']) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      for (const hit of findBareBackdropClicks(fs.readFileSync(file, 'utf8'))) {
        if ((ALLOWED[rel] || []).includes(hit.onClick)) continue;
        hits.push(`${rel}:${hit.line} <${hit.tag} onClick=${hit.onClick.slice(0, 80)}>`);
      }
    }
  }
  return hits;
}

describe('backdrop click guard', () => {
  it('the scanner catches a bare backdrop close (and ignores the safe forms)', () => {
    const bad = `
      export function A({ onClose }) {
        return (
          // a comment between return and the tag
          <div className="fixed inset-0 bg-black/50" onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()}>x</div>
          </div>
        )
      }
      const B = () => <div style={{ position: 'fixed', inset: 0 }} onClick={() => setOpen(false)} />
    `;
    expect(findBareBackdropClicks(bad).map((h) => h.onClick)).toEqual(['{onClose}', '{() => setOpen(false)}']);

    const good = `
      const A = () => (
        <div className="fixed inset-0" {...backdropDismiss(onClose)}>
          <div className="fixed" onClick={(e) => { e.stopPropagation(); e.preventDefault() }} />
          <button className="fixed inset-0" onClick={onClose}>x</button>
          <p>Don't stop: a < b</p>
        </div>
      )
    `;
    expect(findBareBackdropClicks(good)).toEqual([]);
  });

  it('no overlay in src/ or scoresheet_pdf/ closes on a bare backdrop onClick', () => {
    expect(scan()).toEqual([]);
  });
});
