/**
 * The page the server prints the official vector PDF from (escoresheet/render,
 * field-spec 17.20). Headless Chromium opens it, calls window.ovRender with a
 * match record as the manager's Rebuild PDF reads it (GET
 * /api/scoresheets/:id/match plus the account approvals), and prints it with
 * page.pdf(). The sheet is the same App_Scoresheet the scorer's device and
 * the manager draw, fed by the same builder (scoresheetDataFromCloud), so the
 * vector PDF prints what they print: the PDF is no longer a picture of the
 * sheet but the sheet itself (selectable text, exact lines, embedded font).
 *
 * Nothing here talks to the network: the record comes in through ovRender,
 * and the renderer serves this page and its assets itself.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../scoresheet_pdf/scoresheet.css';
import '../src/i18n';
import App, { type SheetInfo } from '../scoresheet_pdf/App_Scoresheet';
import { scoresheetDataFromCloud } from '../src/utils/scoresheetFromCloud';
import { rebuildRemark } from '../scoresheet_pdf/utils/sheetRemarks';
import { missingPictures, picturesReady, nextFrames } from '../scoresheet_pdf/utils/pdfCapture';

export interface RenderPayload {
  /** { match, sets, events, liveState, approvals }: lib/scoresheets.js renderRecord */
  record: { match: object; sets?: object[]; events?: object[]; liveState?: object | null; approvals?: object[] };
  /** An admin's rebuild: "Rebuilt after the match: <date> - <reason>" in REMARKS */
  rebuildReason?: string | null;
  /** When the rebuild was asked for (ISO): the remark's date, not the render's */
  rebuiltAt?: string | null;
  /** Tests: also return the sheet's text as the page shows it */
  withText?: boolean;
}

export interface RenderResult {
  ok: boolean;
  filename: string;
  title: string;
  remarksClipped: boolean;
  remarksPages: boolean;
  missingPictures: string[];
  sheetText?: string;
  error?: string;
}

declare global {
  interface Window {
    ovRender?: (payload: RenderPayload) => Promise<RenderResult>;
  }
}

/** Resolves once the sheet's DOM has been quiet for `quietMs` (FitText refits), at most `maxMs`. */
function settled(root: Element, quietMs = 250, maxMs = 6000): Promise<void> {
  return new Promise(resolve => {
    let timer = setTimeout(done, quietMs);
    const stop = setTimeout(done, maxMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(stop);
      resolve();
    }
  });
}

/** Every text node of the sheet, space-separated (textContent glues neighbouring cells together). */
function textOf(root: Element): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n.nodeValue || '');
  return out.join(' ');
}

function waitFor<T>(get: () => T | null | undefined, maxMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      if (performance.now() - t0 > maxMs) return reject(new Error('timeout'));
      requestAnimationFrame(tick);
    };
    tick();
  });
}

window.ovRender = async ({ record, rebuildReason, rebuiltAt, withText }: RenderPayload): Promise<RenderResult> => {
  const base = { ok: false, filename: '', title: '', remarksClipped: false, remarksPages: false, missingPictures: [] as string[] };
  try {
    const matchData = scoresheetDataFromCloud(record);
    const extraRemarks = rebuildReason ? [rebuildRemark(rebuildReason, rebuiltAt ? new Date(rebuiltAt) : new Date())] : [];
    let info: SheetInfo | null = null;
    const host = document.getElementById('root')!;
    ReactDOM.createRoot(host).render(
      <App matchData={matchData} readOnly extraRemarks={extraRemarks} onSheetInfo={(i) => { info = i; }} />
    );
    const sheet = await waitFor(() => document.querySelector('.scoresheet-container'));
    await (document as any).fonts?.ready;
    await picturesReady(sheet);
    await nextFrames();
    await settled(sheet);
    await waitFor(() => info);
    const got = info as unknown as SheetInfo;
    let remarksPages = false;
    if (got.remarksClipped && got.remarksAll) {
      const pages = document.createElement('section');
      pages.className = 'ov-remarks-pages';
      pages.setAttribute('data-testid', 'remarks-pages');
      const h1 = document.createElement('h1');
      h1.textContent = 'REMARKS (continued from the scoresheet)';
      const h2 = document.createElement('h2');
      h2.textContent = got.title;
      const pre = document.createElement('pre');
      pre.textContent = got.remarksAll;
      pages.append(h1, h2, pre);
      document.body.appendChild(pages);
      remarksPages = true;
    }
    const missing = missingPictures(sheet).map(img => img.alt || img.src.slice(0, 40));
    return { ...base, ok: true, filename: got.filename, title: got.title, remarksClipped: got.remarksClipped, remarksPages, missingPictures: missing, ...(withText ? { sheetText: textOf(sheet) } : {}) };
  } catch (err) {
    return { ...base, error: String((err as Error)?.message || err).slice(0, 300) };
  }
};

document.documentElement.setAttribute('data-ov-render-ready', '1');
