import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
// The sheet's own base styles (font, line height, preflight, .ss-rule): the same
// sheet wherever it is mounted (standalone page, Rebuild PDF, referee view)
import './sheet.css';
import { remarksText } from './components/FooterSection';
import { LiberoControlSheet } from './components/LiberoControlSheet';
import { SheetPage } from './components/SheetPage';
import type { SanctionRecord } from './types_scoresheet';
import { buildScoresheetFilename, buildScoresheetTitle } from './utils/sheetFormat';
import { capturePixelRatio, drawableImages, drawImagesOnto, hideImages, isWebKitEngine, missingPictures, nextFrames, picturesReady, sheetFontEmbedCSS, styleListFor, usedStyleProperties, wellFormedSheet } from './utils/pdfCapture';
import { matchLfpTracking, deviceLfpSetting } from '../src/domain/sheetInputs.js';
import { useMatchTz } from '../src/ui/useMatchTz.js';
import { deliverPdfToOpener, getOpenerWindow, isOwnDownload, reportPdfProgress, savePdfThroughApp, setPdfBusy, watchPdfWindowClose } from '../src/utils/appWindowGuest';
import { detectAppPlatform } from '../src/utils/openAppWindow';
import { onPointHubBoard } from '../src/utils/pointHubBoard';
import { hideSystemBars, showSystemBars } from '../src/utils/nativeSystemBars';
import { Maximize, Minimize } from 'lucide-react';
import { assertCanvas, assertJpegDataUrl, assertValidPdf, assertVisibleSheet, downloadBlob, PdfCheckError, SHEET_MM, SHEET_OFFSET_MM, type SaveOutcome } from './utils/pdfOutput';
import { usePinchZoom } from './usePinchZoom';
import { applyTextFont } from './utils/pdfFont';
import { writeRemarksPages } from './utils/remarksPages';
import { normalizeMatchData } from './utils/matchData';
import { buildSheetModel } from './utils/sheetModel';

interface AppScoresheetProps {
  /** As any renderer hands it over: normalised first (utils/matchData), so lists may be missing or loose. */
  matchData: {
    match: any;
    homeTeam?: any;
    awayTeam?: any;
    homePlayers?: any[];
    awayPlayers?: any[];
    sets?: any[];
    events?: any[];
    sanctions?: SanctionRecord[];
  };
  autoAction?: 'preview' | 'print' | 'save' | 'getBlob';
  /**
   * Every live query has answered (LiveScoresheet). The automatic save / getBlob
   * waits for it: the first render has the match but not yet its teams, players,
   * sets and events. Static data (storage, import) is ready at once.
   */
  dataReady?: boolean;
  /** ?matchId= named a match that is not on this device: show it, never save an empty sheet. */
  matchMissing?: boolean;
  /**
   * A view only (the referee tablet's live scoresheet): no Save PDF, no
   * fullscreen, no signing on the rosters, no orientation lock.
   */
  readOnly?: boolean;
  /**
   * Inside another page's full-screen layer instead of a page of its own: it
   * fills its parent (the sheet scrolls inside it) and Fit leaves this much
   * room above it (px) for that page's bar.
   */
  embedded?: boolean;
  reservedTop?: number;
  /**
   * Remarks the caller adds after the sheet's own (an admin's "Rebuild PDF":
   * "Rebuilt after the match: <date> - <reason>", owner 2026-11-16).
   */
  extraRemarks?: string[];
  /**
   * With autoAction 'getBlob': the PDF (or null when it could not be made)
   * goes to this callback instead of the window that opened the page (the
   * manager draws the sheet on its own page to rebuild it).
   */
  onBlob?: (out: { blob: Blob; filename: string } | null) => void;
  /**
   * What a page that prints the sheet itself needs besides the sheet (the
   * server's vector PDF, render/main.tsx): the file name, the title, and the
   * full REMARKS text when the box cuts it off (it then goes on further pages).
   */
  onSheetInfo?: (info: SheetInfo) => void;
}

export interface SheetInfo {
  filename: string;
  title: string;
  remarksClipped: boolean;
  remarksAll: string;
}

// The sheet's size in CSS px (w-[410mm] h-[287mm]; 96 px per inch)
const SHEET_W_PX = (410 * 96) / 25.4;
const SHEET_H_PX = (287 * 96) / 25.4;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;

/** A PDF being made whose view was closed: dropped, never handed on. */
class CaptureAbandoned extends Error {}

const App: React.FC<AppScoresheetProps> = ({ matchData, autoAction, dataReady = true, matchMissing = false, readOnly = false, embedded = false, reservedTop = 0, extraRemarks, onBlob, onSheetInfo }) => {
  const { t } = useTranslation();
  // One shape whichever renderer drew the input (utils/matchData): a JSON
  // import or an older row may miss lists or hold null; sets by index, events
  // by seq, as this device's database reads them
  const data = useMemo(() => normalizeMatchData(matchData), [matchData]);
  const match: any = data.match;
  // every clock on the sheet reads the match's own zone (domain/sheetInputs)
  useMatchTz(match?.tz);
  // LFP marks print only where LFP tracking is on (owner 2026-11-16): the
  // match's own setting (kept at the coin toss, domain/sheetInputs), else this
  // device's (older matches)
  const lfpShown = matchLfpTracking(match, deviceLfpSetting());
  // The whole sheet, once per data change (utils/sheetModel): a zoom, a turn,
  // a notice or the PDF-busy flag re-render this shell, never the drawn page
  const extraKey = JSON.stringify(Array.isArray(extraRemarks) ? extraRemarks : []);
  const model = useMemo(
    () => buildSheetModel(data, { lfpShown, extraRemarks }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, lfpShown, extraKey, match?.tz]
  );
  const {
    homeTeam, awayTeam, sets, teamAKey, coinTossConfirmed, bestOf, sheetHomeTeam, sheetAwayTeam, teamAName, teamBName,
    lcsData, hasLiberoActivity, sheetWarnings, overflowSanctions, autoRemarks, remarks, result
  } = model;

  // Toggle between scoresheet and LCS view
  const [showLCS, setShowLCS] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // REMARKS too long for its box even at the smallest size: warned above the
  // sheet, and the PDF prints the whole text on further pages (field-spec 8:
  // never truncate)
  const [remarksClipped, setRemarksClipped] = useState(false);
  // ... as the sheet last drawn, for the PDF made from it: its further pages
  // follow the sheet captured, also when the capture began before the REMARKS
  // box's first fit was reported (an automatic save right after the load)
  const remarksClippedRef = useRef(remarksClipped);
  remarksClippedRef.current = remarksClipped;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sheetBoxRef = useRef<HTMLDivElement>(null);


  // Zoom state for tablet/viewport control
  const [zoomLevel, setZoomLevel] = useState(1);
  // Fullscreen (owner 2026-11-24: "the PDF actually go full picture"): the
  // bar goes, the sheet is fitted to the whole screen (above 100 % on a big
  // one) and only an exit button stays in the corner. The browser's or the
  // desktop app's fullscreen, and the Android app's bars hidden, where the
  // platform allows it; the view fills the window either way.
  const [fullView, setFullView] = useState(false);
  const fullViewRef = useRef(false);
  fullViewRef.current = fullView;

  // Viewport tracking for portrait/landscape detection
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1366);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 768);
  const isLandscape = viewportWidth >= viewportHeight;
  // A phone held upright (or an app that does not rotate, e.g. with the
  // phone's auto-rotate off): the landscape sheet is shown turned by 90°, so
  // it fills the screen and reads the right way up once the phone is turned.
  // "Turn" switches back to the upright, much smaller view. Never while a PDF
  // is made: html-to-image would capture the turned sheet.
  // Tablets held upright too (owner 2026-11-09: the referee's sheet opened
  // at about 50 % on an upright tablet): every portrait screen gets "Turn".
  const portraitPhone = !isLandscape;
  const [turnedPref, setTurnedPref] = useState(true);

  const zoomIn = () => setZoomLevel(prev => Math.min(prev + 0.1, MAX_ZOOM));
  // The floor fits the upright sheet on a 360 px phone (about 0.21); at 0.3
  // it stayed wider than the screen and Fit could not fit it
  const zoomOut = () => setZoomLevel(prev => Math.max(prev - 0.1, MIN_ZOOM));
  const resetZoom = () => setZoomLevel(1);
  // While two fingers pinch: the box and the sheet's scale written directly, the drawn sheet
  // scaled as one layer (will-change); React sets the same styles when the fingers lift
  const previewZoom = (z: number, moving: boolean) => {
    const box = sheetBoxRef.current;
    const sheet = containerRef.current;
    if (!box || !sheet || !boxedRef.current) return false;
    const turnedNow = turnedRef.current;
    box.style.width = `${(turnedNow ? SHEET_H_PX : SHEET_W_PX) * z}px`;
    box.style.height = `${(turnedNow ? SHEET_W_PX : SHEET_H_PX) * z}px`;
    sheet.style.transform = turnedNow ? `translateX(${SHEET_H_PX * z}px) rotate(90deg) scale(${z})` : `scale(${z})`;
    sheet.style.willChange = moving ? 'transform' : '';
    return true;
  };
  usePinchZoom({ scrollRef: scrollContainerRef, boxRef: sheetBoxRef, zoom: zoomLevel, setZoom: setZoomLevel, preview: previewZoom, min: MIN_ZOOM, max: MAX_ZOOM });

  const fitToScreen = (full = fullViewRef.current) => {
    if (!containerRef.current) return;
    // Get viewport dimensions (minus toolbar height ~50px); in the full view
    // only the scroll area's own padding (p-2)
    const viewportWidth = window.innerWidth - (full ? 16 : 32); // padding
    const viewportHeight = window.innerHeight - (full ? 16 : 70 + reservedTop); // toolbar + padding (+ the host page's bar)
    // Scoresheet is 410mm x 287mm, convert to px (1mm ≈ 3.78px at 96 DPI);
    // turned, its width runs down the screen
    const scoresheetWidth = (turnedRef.current ? 287 : 410) * 3.78;
    const scoresheetHeight = (turnedRef.current ? 410 : 287) * 3.78;
    const zoomX = viewportWidth / scoresheetWidth;
    const zoomY = viewportHeight / scoresheetHeight;
    const optimalZoom = Math.min(zoomX, zoomY, full ? MAX_ZOOM : 1);
    setZoomLevel(Math.max(MIN_ZOOM, Math.floor(optimalZoom * 100) / 100));
  };

  // true once the platform's own fullscreen came on for the full view: when
  // it ends (Esc, the browser's own exit), the full view ends with it
  const platformFullRef = useRef(false);
  const enterFullView = async () => {
    setFullView(true);
    void hideSystemBars().catch(() => {});
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen not allowed here, the view fills the window:', err);
    }
  };
  const exitFullView = async () => {
    setFullView(false);
    platformFullRef.current = false;
    void showSystemBars().catch(() => {});
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
    } catch (err) {
      console.warn('Exit fullscreen failed:', err);
    }
  };

  // The platform's fullscreen ended by itself (Esc, the browser's bar): leave the full view too
  useEffect(() => {
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) {
        if (fullViewRef.current) platformFullRef.current = true;
      } else if (platformFullRef.current) {
        platformFullRef.current = false;
        setFullView(false);
        void showSystemBars().catch(() => {});
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Esc ends the full view (the browser's own Esc ends its fullscreen too;
  // the Android app and a frame have none)
  useEffect(() => {
    if (!fullView) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void exitFullView(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullView]);

  // The Android app's bars come back if the sheet closes while they are hidden
  useEffect(() => () => { if (fullViewRef.current) void showSystemBars().catch(() => {}); }, []);

  // Lock orientation to landscape for scoresheet (not as a view inside another
  // page: the referee tablet keeps its own orientation)
  useEffect(() => {
    if (readOnly) return undefined;
    const lockLandscape = async () => {
      try {
        const orientation = screen.orientation as any;
        if (orientation && orientation.lock) {
          await orientation.lock('landscape');
          console.log('[Scoresheet] Orientation locked to landscape');
        }
      } catch (err) {
        console.log('[Scoresheet] Orientation lock not supported:', err);
      }
    };
    lockLandscape();

    return () => {
      // Unlock orientation when leaving scoresheet
      const orientation = screen.orientation as any;
      if (orientation && orientation.unlock) {
        try {
          orientation.unlock();
        } catch (err) {
          // Ignore unlock errors
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track viewport size for portrait/landscape detection
  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // The full view fits the sheet to the whole screen, again when the screen
  // changes size (the platform's fullscreen arrives a moment later); leaving
  // it fits the sheet as on opening
  const fullViewSeen = useRef(false);
  useEffect(() => {
    if (generatingRef.current) return;
    if (fullView) {
      fullViewSeen.current = true;
      fitToScreen(true);
    } else if (fullViewSeen.current) {
      fullViewSeen.current = false;
      if (window.innerWidth < 410 * 3.78) fitToScreen(false);
      else setZoomLevel(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullView, viewportWidth, viewportHeight]);

  // Auto-fit to screen on mount if viewport is smaller than scoresheet
  useEffect(() => {
    const viewportWidth = window.innerWidth;
    const scoresheetWidth = 410 * 3.78; // ~1550px
    if (viewportWidth < scoresheetWidth) {
      fitToScreen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // State for PDF generation
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const turned = portraitPhone && turnedPref && !showLCS && !isGeneratingPdf;
  // The sheet sits in a box of its scaled size, so a sheet wider than the
  // screen scrolls from its left edge (centred, it hung out on both sides and
  // its left part could not be reached)
  const boxed = !showLCS && !isGeneratingPdf;
  const boxedRef = useRef(boxed);
  boxedRef.current = boxed;
  const turnedRef = useRef(turned);

  // Fit again when the view turns (the phone rotated, or "Turn")
  useEffect(() => {
    turnedRef.current = turned;
    // a PDF being made sets its own zoom (100 %)
    if (generatingRef.current) return;
    if (window.innerWidth < 410 * 3.78) fitToScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turned]);

  const generatingRef = useRef(false);
  // false once this view is gone (the manager's Rebuild PDF cancelled or timed
  // out): a capture still running stops at its next step and hands nothing on
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Where the PDF went, shown next to the buttons until dismissed (field-spec 13.5):
  // the full path on the desktop (Open file / Show in folder), the file name in a
  // browser, or why it failed. Not alert(): in the desktop app the dialog plugin
  // replaces it and this window may not call it.
  const [saveOutcome, setSaveOutcome] = useState<SaveOutcome | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The file name of this window's last "Save PDF" download: on Linux every
  // window hears every download (the scoretable's match-end ZIP too).
  const pendingDownload = useRef<string | null>(null);
  useEffect(() => {
    const onFinished = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string | null; fileName?: string | null; success?: boolean; id?: number | null }>).detail || {};
      if (!isOwnDownload(detail, pendingDownload.current)) return;
      const fileName = detail.fileName || pendingDownload.current || '';
      pendingDownload.current = null;
      setActionError(null);
      setSaveOutcome(detail.success && detail.path
        ? { kind: 'desktop', fileName, path: detail.path, id: detail.id ?? null }
        : { kind: 'failed', message: t('appWindow.downloadFailed', 'The download did not finish.') });
    };
    window.addEventListener('ov-download-finished', onFinished);
    return () => window.removeEventListener('ov-download-finished', onFinished);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // A match that is not on this device: say so on the page itself, not only when saving
  useEffect(() => {
    if (matchMissing) {
      setSaveOutcome({ kind: 'failed', message: t('scoresheetPdf.matchNotFound', 'This match is not on this device: there is no scoresheet to save.') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchMissing]);

  // The data of the LATEST render: a save started by autoAction or a click always
  // names the file after what is on the sheet now (the first render had no teams yet:
  // "match_HOME_AWAY_<date>.pdf").
  const latestData = useRef({ match, homeTeam, awayTeam, sets });
  latestData.current = { match, homeTeam, awayTeam, sets };

  const handleSavePdf = async (returnBlob = false): Promise<{ blob: Blob; filename: string } | void> => {
    if (!containerRef.current || generatingRef.current) return;
    if (matchMissing) {
      // ?matchId= of a match that is not on this device: never save an empty sheet
      if (!returnBlob) setSaveOutcome({ kind: 'failed', message: t('scoresheetPdf.matchNotFound', 'This match is not on this device: there is no scoresheet to save.') });
      return;
    }

    generatingRef.current = true;
    setIsGeneratingPdf(true);
    setSaveOutcome(null);
    setActionError(null);
    const savedZoomLevel = zoomLevel;
    const wasShowingLCS = showLCS;
    // the desktop app's quit question says a PDF is still being saved here
    setPdfBusy(true);
    // the approval's log: this page's own time until now (load, read, render)
    reportStep('capture', performance.now());

    // the view is gone (Rebuild PDF cancelled or timed out): stop here
    const stillShown = () => { if (!mountedRef.current) throw new CaptureAbandoned(); };
    try {
      const data = latestData.current;
      const filename = buildScoresheetFilename(data);
      const title = buildScoresheetTitle(data);

      // the sheet font's CSS for the capture, read while the view settles (utils/pdfCapture.ts)
      const fontEmbedCSS = sheetFontEmbedCSS();

      // Capture the sheet itself at 100 %: back from the libero control sheet (the
      // sheet is display:none there, it is laid out and fitted anew), zoom reset
      // (only a transform: the next frame), fonts loaded
      if (wasShowingLCS) setShowLCS(false);
      setZoomLevel(1);
      await (wasShowingLCS ? new Promise(resolve => setTimeout(resolve, 250)) : nextFrames());
      stillShown();
      await (document as any).fonts?.ready;
      // FitText fits its text again once a font has loaded: let that render land
      await nextFrames();
      stillShown();

      const sheet = containerRef.current;
      assertVisibleSheet(sheet);
      // every logo and signature loaded and decoded (at most 3 s), else the PDF
      // came out without it and nobody knew (utils/pdfCapture.ts)
      await picturesReady(sheet!, 3000);
      stillShown();
      const missing = missingPictures(sheet!);
      if (missing.length > 0) {
        console.warn(`[Scoresheet] ${missing.length} picture(s) did not load and are not in the PDF:`, missing.map(img => img.alt || img.getAttribute('data-testid') || 'picture').join(', '));
      }

      // Lazy-load PDF libraries (only needed when generating PDF)
      const [htmlToImage, { jsPDF }] = await Promise.all([
        import('html-to-image'),
        import('jspdf')
      ]);
      stillShown();

      // only the sheet's own font, built once per page; null: html-to-image looks for it
      const fontCss = await fontEmbedCSS;
      stillShown();

      // pixelRatio 2: ~190 dpi on A3, sharp enough for print, a reasonable file
      // size; 1.5 with Options › Effects and speed › Sharp PDF off, the
      // default in the Android app (capturePixelRatio, utils/pdfCapture.ts:
      // the device's choice, read now). The PDF places the picture in mm, at
      // any ratio.
      const pixelRatio = capturePixelRatio(window);
      const capture = (props: string[]) => htmlToImage.toCanvas(sheet!, {
        pixelRatio,
        backgroundColor: '#ffffff',
        style: {
          transform: 'none',
        },
        includeStyleProperties: styleListFor(props),
        ...(fontCss ? { fontEmbedCSS: fontCss } : {}),
      });
      // Each step's time from here on, for the approval's log (reportStep)
      let lapAt = performance.now();
      const lap = (step: string) => {
        const now = performance.now();
        reportStep(step, now - lapAt);
        lapAt = now;
      };
      // Every engine copies only the properties the sheet uses (utils/pdfCapture.ts):
      // the full copy was a ~100 MB SVG that took ~10 s in Chromium (Brave) and
      // that WebKit cannot load at all. WebKit (the Linux and macOS desktop apps,
      // Safari, every iPhone / iPad browser) also draws the logos and signatures
      // itself, as it paints pictures nested in the SVG only now and then.
      // Elsewhere a failed capture is tried once more the WebKit way (pictures drawn
      // afterwards), never with the full copy: that is ~8x larger and fails for the
      // same reasons, worst on an Android tablet short of memory.
      const leanWithPictures = async () => {
        const pictures = drawableImages(sheet!);
        const showPictures = hideImages(pictures);
        let c: HTMLCanvasElement;
        try {
          const props = usedStyleProperties(sheet!);
          lap('styles');
          c = await capture(props);
        } finally {
          showPictures();
        }
        drawImagesOnto(c, sheet!, pictures);
        lap('canvas');
        return c;
      };
      let canvas: HTMLCanvasElement;
      // half an emoji on the sheet made both captures throw (utils/pdfCapture.ts)
      const restoreText = wellFormedSheet(sheet!);
      try {
        if (isWebKitEngine()) {
          canvas = await leanWithPictures();
        } else {
          try {
            const props = usedStyleProperties(sheet!);
            lap('styles');
            canvas = await capture(props);
            lap('canvas');
          } catch (err) {
            console.warn('[Scoresheet] Capture failed, retrying with the pictures drawn afterwards:', err);
            lap('retry');
            stillShown();
            canvas = await leanWithPictures();
          }
        }
      } finally {
        restoreText();
      }
      // a sheet taken off the page during the capture may have come out blank
      stillShown();
      assertCanvas(canvas);

      const imgData = canvas.toDataURL('image/jpeg', 0.85);
      lap('jpeg');
      assertJpegDataUrl(imgData);

      // A3 landscape (420 x 297 mm); the 410 x 287 mm sheet placed at its true size,
      // centred (5 mm margins): to scale, circles stay circles
      const pdf = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: 'a3',
        compress: true
      });
      // the title is the scoresheet's name, as its file: a PDF viewer shows it in its
      // bar (owner 2026-10-13); the teams, date and game go in the subject
      pdf.setProperties({
        title: filename.replace(/\.pdf$/i, ''),
        subject: title,
        creator: 'OpenVolley eScoresheet',
        keywords: 'OpenVolley, eScoresheet, volleyball, scoresheet'
      });
      pdf.addImage(imgData, 'JPEG', SHEET_OFFSET_MM.x, SHEET_OFFSET_MM.y, SHEET_MM.width, SHEET_MM.height, undefined, 'FAST');
      // A searchable line (title, result) under the picture, not drawn. jsPDF writes
      // this text itself: names or remarks beyond Latin-1 get an embedded Unicode
      // font (utils/pdfFont), Helvetica garbled them.
      try {
        const searchLine = `${title}${result ? ` - ${result.replace('-', ':')}` : ''}`;
        await applyTextFont(pdf, searchLine);
        pdf.setFontSize(6);
        pdf.text(searchLine, SHEET_OFFSET_MM.x, 3, { renderingMode: 'invisible' } as any);
      } catch { /* text layer is optional */ }
      if (remarksClippedRef.current) {
        const all = remarksText({ overflowSanctions, remarks, generated: autoRemarks });
        await applyTextFont(pdf, `${title}\n${all}`);
        // as many pages as the text needs (utils/remarksPages)
        writeRemarksPages(pdf, title, all);
      }

      stillShown();
      const bytes = pdf.output('arraybuffer');
      lap('pdf');
      assertValidPdf(bytes);
      const pdfBlob = new Blob([bytes], { type: 'application/pdf' });

      if (returnBlob) {
        return { blob: pdfBlob, filename };
      }
      if (await savePdfThroughApp(pdfBlob, filename)) {
        // Android in-app view: the app writes it and its bar says where (with Open / Share)
        setSaveOutcome({ kind: 'app', fileName: filename });
        return;
      }
      // A download. The desktop app puts it in Downloads and reports the full path
      // (ov-download-finished); a browser keeps it in its download folder.
      pendingDownload.current = filename;
      downloadBlob(pdfBlob, filename);
      setSaveOutcome(detectAppPlatform(window) === 'tauri' || getOpenerWindow() && detectAppPlatform(getOpenerWindow() as Window & typeof globalThis) === 'tauri'
        ? { kind: 'desktop-pending', fileName: filename }
        : { kind: 'web', fileName: filename });
    } catch (error) {
      if (error instanceof CaptureAbandoned) {
        console.info('[Scoresheet] PDF dropped: the view was closed while it was made');
        return;
      }
      console.error('Error generating PDF:', error);
      if (!returnBlob) {
        setSaveOutcome({
          kind: 'failed',
          message: error instanceof PdfCheckError
            ? t('scoresheetPdf.pdfInvalid', 'The PDF could not be created correctly. Please try again.')
            : t('scoresheetPdf.pdfFailed', 'The PDF could not be created on this device.')
        });
      }
    } finally {
      // the zoom and the view the scorer had, also after a failure
      setZoomLevel(savedZoomLevel);
      if (wasShowingLCS) setShowLCS(true);
      generatingRef.current = false;
      setIsGeneratingPdf(false);
      setPdfBusy(false);
    }
  };
  // Always the latest closure (latest data, latest state) for the automatic action
  const handleSavePdfRef = useRef(handleSavePdf);
  handleSavePdfRef.current = handleSavePdf;

  // Open / show the saved file through the desktop app (popups.rs download_open /
  // download_reveal: only a download it recorded itself, by its id)
  const runDownloadAction = async (command: 'download_open' | 'download_reveal', id: number | null | undefined) => {
    setActionError(null);
    try {
      const internals = (window as any).__TAURI_INTERNALS__;
      if (!internals?.invoke || id === null || id === undefined) throw new Error('not available');
      await internals.invoke(command, { id });
    } catch (e) {
      setActionError(t('scoresheetPdf.fileActionFailed', 'The file could not be opened from here. It is in: {{path}}', {
        path: saveOutcome && saveOutcome.kind === 'desktop' ? saveOutcome.path : ''
      }));
    }
  };

  // Automatic action (?action=print|save|getBlob): once every query has answered
  // (dataReady), never on the first render with half the data; once only.
  const autoActionDone = useRef(false);
  // the caller's own receiver of the getBlob PDF (latest one), else the opener
  const onBlobRef = useRef(onBlob);
  onBlobRef.current = onBlob;
  // true while the approval (getBlob) still waits for this window's PDF
  const approvalBusyRef = useRef(autoAction === 'getBlob');
  // The approval's log (MatchEnd: 'timing'): one message at each step of the
  // capture with the time it took here, numbers only. The beat below runs on
  // the thread the capture holds, so on the Android in-app view it is heard
  // late. Never throws: a step of the capture never fails for it.
  const reportStep = (step: string, ms: number) => {
    try {
      if (autoAction !== 'getBlob' || onBlobRef.current || !approvalBusyRef.current) return;
      reportPdfProgress({ step, ms });
    } catch { /* the log only */ }
  };
  useEffect(() => {
    if (!autoAction || autoAction === 'preview' || !dataReady || autoActionDone.current) return;
    autoActionDone.current = true;

    const timer = setTimeout(async () => {
      await (document as any).fonts?.ready;
      // the first renders' own updates land first (Fit's zoom, the REMARKS
      // box's fit): handleSavePdfRef is then the closure that holds them
      await nextFrames();
      if (!mountedRef.current) return;
      if (autoAction === 'print' || autoAction === 'save') {
        await handleSavePdfRef.current();
      } else if (autoAction === 'getBlob') {
        // Generate the PDF and hand it to the opener (MatchEnd's approval),
        // or tell it the capture failed so it does not wait for its timeout;
        // then close this window / the in-app view either way.
        const out = matchMissing ? null : await handleSavePdfRef.current(true);
        // closed meanwhile (the manager's Rebuild PDF cancelled or timed out):
        // whatever came out goes nowhere, not even as a failure
        if (!mountedRef.current) return;
        // delivered (or failed): closing this window from now on cancels nothing
        approvalBusyRef.current = false;
        if (onBlobRef.current) onBlobRef.current(out || null);
        else await deliverPdfToOpener(out || null);
      }
      // No fixed wait (it was 500 ms): the frames above, and handleSavePdf
      // waits for two more, the fonts and the pictures. The timer stays, so
      // its cleanup cancels the first of the two runs of this effect under
      // React's StrictMode (index_scoresheet).
    }, 0);

    return () => { clearTimeout(timer); autoActionDone.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAction, dataReady]);

  // The approval (getBlob) waits for this window: a heartbeat once a second
  // while it works, and closing the window tells MatchEnd at once
  // (scoresheetPdfRequest.js), which then asks the scorer what to do.
  useEffect(() => {
    // no opener waits for a PDF the caller takes itself (onBlob)
    if (autoAction !== 'getBlob' || onBlobRef.current) return undefined;
    const stopWatch = watchPdfWindowClose(() => approvalBusyRef.current);
    const beat = () => { if (approvalBusyRef.current) reportPdfProgress({ step: generatingRef.current ? 'capture' : 'loading' }); };
    beat();
    const timer = setInterval(beat, 1000);
    return () => { clearInterval(timer); stopWatch(); };
  }, [autoAction]);


  // Embedded: one column that fills the host's layer, the sheet scrolling in
  // its own box (pinch zoom and Fit work on that box)
  // The server's vector PDF prints the sheet itself (render/main.tsx): it needs
  // the same file name, title and REMARKS continuation as handleSavePdf
  const onSheetInfoRef = useRef(onSheetInfo);
  onSheetInfoRef.current = onSheetInfo;
  const remarksAllText = remarksClipped
    ? remarksText({ overflowSanctions, remarks: typeof match?.remarks === 'string' ? match.remarks : '', generated: autoRemarks })
    : '';
  const sheetFilename = buildScoresheetFilename({ match, homeTeam, awayTeam, sets });
  const sheetTitle = buildScoresheetTitle({ match, homeTeam, awayTeam, sets });
  useEffect(() => {
    onSheetInfoRef.current?.({ filename: sheetFilename, title: sheetTitle, remarksClipped, remarksAll: remarksAllText });
  }, [sheetFilename, sheetTitle, remarksClipped, remarksAllText]);

  const Root = embedded ? 'div' : React.Fragment;
  const rootProps = embedded ? { className: 'relative flex h-full min-h-0 flex-col bg-gray-100', 'data-testid': 'scoresheet-embedded' } : {};
  return (
    <Root {...rootProps}>
      {/* PDF Generating overlay. Embedded, it covers this view only: the host's
          bar (Rebuild PDF's Cancel) stays usable while the PDF is made. */}
      {isGeneratingPdf && (
        <div data-testid="pdf-generating" style={{
          position: embedded ? 'absolute' : 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.85)',
          zIndex: 99998,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{
            fontSize: '48px',
            marginBottom: '24px',
            animation: 'spin 1s linear infinite'
          }}>
            ⏳
          </div>
          <style>{`
            @keyframes spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
          <h2 style={{
            color: 'white',
            fontSize: '24px',
            fontWeight: 'bold',
            marginBottom: '16px'
          }}>
            {t('scoresheetPdf.generatingPdf', 'Generating PDF...')}
          </h2>
          <p style={{
            color: '#d1d5db',
            fontSize: '16px',
            maxWidth: '400px'
          }}>
            {t('scoresheetPdf.generatingPdfMessage', 'Please wait while the scoresheet is being converted to PDF. This may take a few seconds.')}
          </p>
        </div>
      )}

      {fullView && (
        <button
          type="button"
          onClick={() => void exitFullView()}
          data-testid="sheet-exit-full-view"
          className="fixed right-3 top-3 z-[100] inline-flex h-11 w-11 items-center justify-center rounded-full bg-stone-900/70 text-white shadow-lg backdrop-blur-sm hover:bg-stone-900/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white print:hidden"
          aria-label={t('scoresheetPdf.exitFullscreen', 'Exit fullscreen')}
          title={t('scoresheetPdf.exitFullscreen', 'Exit fullscreen')}
        >
          <Minimize size={20} strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
      {!fullView && <div data-testid="sheet-toolbar" className={`flex flex-col justify-center items-center print:hidden w-full bg-gray-100 py-2 ${embedded ? 'shrink-0' : 'mb-2 sticky top-0 z-50'}`}>
        <div className="flex flex-wrap items-center justify-center gap-2 px-2">
          {/* Zoom controls */}
          <button
            onClick={zoomOut}
            className="bg-gray-500 hover:bg-gray-700 text-white px-3 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.zoomOut', 'Zoom Out')}
          >
            −
          </button>
          <button
            onClick={resetZoom}
            className="bg-gray-500 hover:bg-gray-700 text-white px-2 py-1 rounded text-sm shadow min-w-[50px]"
            title={t('scoresheetPdf.resetZoom', 'Reset Zoom (100%)')}
          >
            {Math.round(zoomLevel * 100)}%
          </button>
          <button
            onClick={() => fitToScreen()}
            className="bg-gray-600 hover:bg-gray-700 text-white px-2 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.fitToScreen', 'Fit to Screen')}
          >
            {t('scoresheetPdf.fit', 'Fit')}
          </button>
          <button
            onClick={zoomIn}
            className="bg-gray-500 hover:bg-gray-700 text-white px-3 py-1 rounded text-sm shadow"
            title={t('scoresheetPdf.zoomIn', 'Zoom In')}
          >
            +
          </button>

          {/* A phone held upright: the sheet turned (fills the screen) or upright */}
          {portraitPhone && !showLCS && (
            <button
              onClick={() => setTurnedPref(prev => !prev)}
              className={`${turnedPref ? 'bg-gray-700' : 'bg-gray-500 hover:bg-gray-700'} text-white px-3 py-1 rounded text-sm shadow`}
              title={t('scoresheetPdf.turnTooltip', 'Turn the sheet: it fills the screen when you turn the phone')}
              aria-pressed={turnedPref}
            >
              ⟳ {t('scoresheetPdf.turn', 'Turn')}
            </button>
          )}

          {/* Divider */}
          <div className="w-px h-6 bg-gray-400"></div>

          {/* A Point Hub board's windows have no frame: this is the way back */}
          {!readOnly && onPointHubBoard() && (
            <button
              onClick={() => window.close()}
              className="bg-gray-700 hover:bg-gray-900 text-white px-3 py-1 rounded text-sm shadow"
            >
              {t('scoresheetPdf.dismiss', 'Close')}
            </button>
          )}

          {/* Fullscreen: the sheet alone on the whole screen (a view-only sheet: its page's own) */}
          {!readOnly && <button
            type="button"
            onClick={() => void enterFullView()}
            data-testid="sheet-full-view"
            className="inline-flex items-center justify-center bg-blue-500 hover:bg-blue-700 text-white px-2.5 py-1 rounded text-sm shadow"
            aria-label={t('scoresheetPdf.fullscreen', 'Fullscreen')}
            title={t('scoresheetPdf.fullscreen', 'Fullscreen')}
          >
            <Maximize size={18} strokeWidth={2.25} aria-hidden="true" />
          </button>}

          {/* Save PDF button (one-click, no dialog); not in a view-only sheet */}
          {!readOnly && <button
            onClick={() => handleSavePdf()}
            disabled={isGeneratingPdf}
            className={`${isGeneratingPdf ? 'bg-purple-400 cursor-wait' : 'bg-purple-500 hover:bg-purple-700'} text-white px-3 py-1 rounded text-sm shadow`}
            title={t('scoresheetPdf.savePdfTooltip', 'Save as PDF (one-click download)')}
          >
            {isGeneratingPdf ? t('scoresheetPdf.generating', 'Generating...') : t('scoresheetPdf.savePdf', 'Save PDF')}
          </button>}

          {/* Libero Control Sheet toggle button - only shown when there is libero activity */}
          {hasLiberoActivity && (
            <button
              onClick={() => setShowLCS(prev => !prev)}
              className={`${showLCS ? 'bg-teal-700' : 'bg-teal-600 hover:bg-teal-700'} text-white px-3 py-1 rounded text-sm shadow`}
              title={showLCS ? t('scoresheetPdf.backToScoresheet', 'Back to Scoresheet') : t('scoresheetPdf.lcsTooltip', 'View Libero Control Sheet')}
            >
              {showLCS ? t('scoresheetPdf.backToScoresheet', 'Scoresheet') : t('scoresheetPdf.lcs', 'Libero Control Sheet')}
            </button>
          )}

        </div>
        {(sheetWarnings.length > 0 || remarksClipped) && (
          <div data-testid="sheet-warnings" className="mt-2 mx-2 max-w-[min(100%,72rem)] rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
            <span className="font-semibold">{t('scoresheetPdf.checkTheMatch', 'Check the match before approving it:')}</span>
            <ul className="list-disc pl-5">
              {sheetWarnings.map((w, i) => <li key={i}>{w}</li>)}
              {remarksClipped && <li data-testid="remarks-clipped-warning">{t('scoresheetPdf.remarksClipped', 'REMARKS: the text does not fit the box; the PDF prints all of it on page 2.')}</li>}
            </ul>
          </div>
        )}
        {/* Where the PDF went: the whole path (wraps, selectable), stays until closed */}
        {saveOutcome && (
          <div
            role="status"
            data-testid="pdf-notice"
            className={`mt-2 mx-2 max-w-[min(100%,72rem)] flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-sm ${saveOutcome.kind === 'failed' ? 'border-red-300 bg-red-50 text-red-800' : 'border-stone-300 bg-white text-stone-800'}`}
          >
            <span className="min-w-0 break-all">
              {saveOutcome.kind === 'desktop' && (
                <>
                  {t('scoresheetPdf.pdfSavedAt', 'PDF saved:')}{' '}
                  <span className="font-mono font-semibold select-all" data-testid="pdf-notice-path">{saveOutcome.path}</span>
                </>
              )}
              {saveOutcome.kind === 'desktop-pending' && t('scoresheetPdf.savingFile', 'Saving {{fileName}}...', { fileName: saveOutcome.fileName })}
              {saveOutcome.kind === 'web' && (
                <>
                  {t('scoresheetPdf.pdfDownloaded', "Downloaded to your browser's download folder:")}{' '}
                  <span className="font-mono font-semibold select-all" data-testid="pdf-notice-path">{saveOutcome.fileName}</span>
                </>
              )}
              {saveOutcome.kind === 'app' && t('scoresheetPdf.pdfHandedToApp', 'The app is saving {{fileName}}: the bar at the top shows where.', { fileName: saveOutcome.fileName })}
              {saveOutcome.kind === 'failed' && saveOutcome.message}
            </span>
            {saveOutcome.kind === 'desktop' && saveOutcome.id !== null && saveOutcome.id !== undefined && (
              <span className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => runDownloadAction('download_open', saveOutcome.id)}
                  className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-semibold text-white hover:bg-stone-700"
                >
                  {t('scoresheetPdf.openFile', 'Open file')}
                </button>
                <button
                  type="button"
                  onClick={() => runDownloadAction('download_reveal', saveOutcome.id)}
                  className="rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-800 hover:bg-stone-100"
                >
                  {t('scoresheetPdf.showInFolder', 'Show in folder')}
                </button>
              </span>
            )}
            {actionError && <span className="text-xs text-red-700 break-all">{actionError}</span>}
            <button
              type="button"
              onClick={() => { setSaveOutcome(null); setActionError(null); }}
              className="ml-auto shrink-0 rounded px-1.5 text-stone-500 hover:text-stone-900"
              aria-label={t('scoresheetPdf.dismiss', 'Close')}
              title={t('scoresheetPdf.dismiss', 'Close')}
            >
              ×
            </button>
          </div>
        )}
      </div>}
      <style>{`
        @media print {
          .scoresheet-container {
            transform: scale(0.72) !important;
            transform-origin: top center !important;
            width: 410mm !important;
            height: 287mm !important;
            margin: 0 auto !important;
          }
          [data-testid="sheet-turn-box"] {
            display: contents !important;
          }
          .scoresheet-scroll-container {
            padding: 0 !important;
            margin: 0 !important;
            overflow: hidden !important;
            width: 297mm !important;
            height: 210mm !important;
            min-height: 0 !important;
            display: flex !important;
            justify-content: center !important;
            align-items: flex-start !important;
          }
        }
      `}</style>
      {/* Full view: the area covers the window and the sheet sits in its middle
          (margin auto on the box, so a sheet zoomed past the screen still
          scrolls from its edge) */}
      <div
        ref={scrollContainerRef}
        data-full-view={fullView ? 'true' : undefined}
        className={`scoresheet-scroll-container ${fullView ? 'fixed inset-0 z-[90]' : embedded ? 'min-h-0 flex-1' : 'min-h-screen'} bg-gray-100 p-2 flex justify-center overflow-auto print:bg-white`}
        style={{ touchAction: 'pan-x pan-y', justifyContent: boxed ? 'flex-start' : undefined }}
      >
        {/* LCS View */}
        {showLCS && (
          <div
            className="ss-sheet flex flex-col items-center gap-4"
            style={{
              transform: `scale(${zoomLevel})`,
              transformOrigin: 'top center',
              transition: 'transform 0.2s ease',
            }}
          >
            <LiberoControlSheet
              match={match}
              homeTeam={sheetHomeTeam}
              awayTeam={sheetAwayTeam}
              teamAName={teamAName}
              teamBName={teamBName}
              teamAKey={teamAKey as 'home' | 'away'}
              lcsData={lcsData}
              coinTossConfirmed={coinTossConfirmed}
              bestOf={bestOf}
            />
          </div>
        )}

        {/* Scoresheet View. Turned (a phone held upright): the box takes the
            turned sheet's size, the sheet is scaled, turned by 90° clockwise
            about its top left corner and moved back into the box. For the Libero
            sheet or a PDF the box is not there (display: contents). */}
        <div
          ref={sheetBoxRef}
          data-testid="sheet-turn-box"
          style={boxed
            ? turned
              ? { width: SHEET_H_PX * zoomLevel, height: SHEET_W_PX * zoomLevel, overflow: 'hidden', flex: 'none', margin: fullView ? 'auto' : '0 auto' }
              : { width: SHEET_W_PX * zoomLevel, height: SHEET_H_PX * zoomLevel, overflow: 'hidden', flex: 'none', margin: fullView ? 'auto' : '0 auto' }
            : { display: 'contents' }}
        >
        <div
          ref={containerRef}
          className="scoresheet-container w-[410mm] h-[287mm] bg-white shadow-xl print:shadow-none p-3 print:p-3 relative"
          style={{
            boxSizing: 'border-box',
            transform: turned
              ? `translateX(${SHEET_H_PX * zoomLevel}px) rotate(90deg) scale(${zoomLevel})`
              : `scale(${zoomLevel})`,
            transformOrigin: boxed ? 'top left' : 'top center',
            display: showLCS ? 'none' : undefined,
          }}
        >
          <SheetPage model={model} readOnly={readOnly} onRemarksClipped={setRemarksClipped} />
        </div>
        </div>
      </div>

    </Root>
  );
};

export default App;