import { useLayoutEffect, useMemo, useRef, useState } from 'react';
// The sheet's own base styles (font, line height, preflight, .ss-rule), scoped
// to .ss-sheet: the set looks as on the printed sheet wherever it is mounted
import './sheet.css';
import { LeftInfoBox } from './components/LeftInfoBox';
import { StandardSet } from './components/StandardSet';
import { SetFive } from './components/SetFive';
import { normalizeMatchData } from './utils/matchData';
import { buildSheetModel, type SheetModel } from './utils/sheetModel';
import { legendProps, setColumnLabel, setFiveProps, standardSetProps, type StandardSetNumber } from './utils/setBoxProps';
import { usePinchZoom } from './usePinchZoom';
import { matchLfpTracking, deviceLfpSetting } from '../src/domain/sheetInputs.js';
import { useMatchTz } from '../src/ui/useMatchTz.js';

/**
 * The scoresheet's input, as every renderer hands it over (utils/matchData
 * MatchData: { match, homeTeam, awayTeam, homePlayers, awayPlayers, sets,
 * events, sanctions }); normalised here, so lists may be missing or loose.
 * A draft (an event list not written yet, e.g. a correction being made) is
 * drawn the same way.
 */
export interface SetPreviewInput {
  match: any;
  homeTeam?: any;
  awayTeam?: any;
  homePlayers?: any[];
  awayPlayers?: any[];
  sets?: any[];
  events?: any[];
  sanctions?: any[];
}

export interface SetPreviewProps {
  matchData: SetPreviewInput;
  /** The set as stored: 1-4, or 5 for the deciding set (a best-of-3's set 3 too). */
  setIndex: number;
  /** Scale the drawing to the width it is given (default). false: paper size (1:1). */
  fit?: boolean;
  /** Zoom on top of the fitted size (1 = fitted). Without it the preview keeps its own (pinch zoom). */
  zoom?: number;
  /** Called with the new zoom when two fingers pinch (controlled zoom). */
  onZoomChange?: (zoom: number) => void;
  className?: string;
}

/**
 * The fitted scale's bounds: never smaller than this (the deciding set, ~290 mm
 * wide, still fits a 360 px phone), never larger (a wide desktop).
 */
export const FIT_MIN = 0.2;
export const FIT_MAX = 2;
/** The zoom's bounds over the fitted size (buttons and pinch). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The SET column beside a set box, as on the sheet (SheetPage). */
function SetColumn({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center w-[30px] shrink-0 border-l border-t border-b border-black p-1 bg-gray-300">
      <div className="flex flex-col items-center font-black text-sm uppercase tracking-widest leading-tight">
        <span>S</span>
        <span>E</span>
        <span>T</span>
      </div>
      <div className="font-black text-sm mt-1">{label}</div>
    </div>
  );
}

/**
 * One set at paper size, from the sheet model: the legend, the SET column and
 * the set's box, drawn by the sheet's own components with SheetPage's props
 * (utils/setBoxProps). Not wrapped: put it in a `.ss-sheet` (SetPreview does).
 */
export function SetPreviewRow({ model, setIndex }: { model: SheetModel; setIndex: number }) {
  if (setIndex === 5) {
    return (
      <div className="flex" data-testid="set-preview-row" data-set-index={5}>
        <div>
          <LeftInfoBox {...legendProps(model, 5)} />
        </div>
        <SetColumn label={setColumnLabel(model, 5)} />
        <div className="flex-1">
          <SetFive {...setFiveProps(model)} />
        </div>
      </div>
    );
  }
  const n = (setIndex >= 1 && setIndex <= 4 ? setIndex : 1) as StandardSetNumber;
  return (
    <div className="flex" data-testid="set-preview-row" data-set-index={n}>
      <LeftInfoBox {...legendProps(model, n)} />
      <div className="flex">
        <SetColumn label={setColumnLabel(model, n)} />
        <div className="flex-1">
          <StandardSet {...standardSetProps(model, n)} />
        </div>
      </div>
    </div>
  );
}

/**
 * One set of the scoresheet as it prints (the scorer's "Set preview"): the
 * same model (utils/sheetModel) and components as the PDF, for a match or a
 * draft of one. Read only. Fitted to the width it is given (ResizeObserver):
 * the fixed-mm drawing is scaled with a CSS transform inside a box of its
 * scaled size, so a zoomed-in set scrolls sideways from its left edge; two
 * fingers zoom it (usePinchZoom, as the scoresheet viewer).
 */
export function SetPreview({ matchData, setIndex, fit = true, zoom: zoomProp, onZoomChange, className }: SetPreviewProps) {
  const data = useMemo(() => normalizeMatchData(matchData), [matchData]);
  const match: any = data.match;
  // the set's clocks (start, end) read the match's own zone, as on the sheet
  useMatchTz(match?.tz);
  const lfpShown = matchLfpTracking(match, deviceLfpSetting());
  const model = useMemo(
    () => buildSheetModel(data, { lfpShown }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, lfpShown, match?.tz]
  );

  const [ownZoom, setOwnZoom] = useState(1);
  const zoom = clamp(zoomProp ?? ownZoom, ZOOM_MIN, ZOOM_MAX);
  const setZoom = onZoomChange ?? setOwnZoom;

  const viewportRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // the width given (viewport) and the drawing's own size (transforms leave
  // offsetWidth / offsetHeight alone)
  const [size, setSize] = useState({ avail: 0, w: 0, h: 0 });
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const sheet = sheetRef.current;
    if (!viewport || !sheet) return undefined;
    const measure = () => {
      const next = { avail: viewport.clientWidth, w: sheet.offsetWidth, h: sheet.offsetHeight };
      setSize(prev => (prev.avail === next.avail && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, []);

  const measured = size.w > 0 && size.h > 0;
  const fitScale = fit && measured && size.avail > 0 ? clamp(size.avail / size.w, FIT_MIN, FIT_MAX) : 1;
  const scale = Math.round(fitScale * zoom * 1000) / 1000;

  // Two fingers: the hook speaks in the drawn scale, the zoom is over the fitted one
  usePinchZoom({
    scrollRef: viewportRef,
    boxRef,
    zoom: scale,
    setZoom: (s: number) => setZoom(clamp(Math.round((s / fitScale) * 100) / 100, ZOOM_MIN, ZOOM_MAX)),
    min: fitScale * ZOOM_MIN,
    max: fitScale * ZOOM_MAX
  });

  return (
    <div
      ref={viewportRef}
      className={`w-full overflow-auto ${className || ''}`}
      style={{ touchAction: 'pan-x pan-y' }}
      data-testid="set-preview"
      data-scale={scale}
    >
      <div
        ref={boxRef}
        style={measured
          ? { width: size.w * scale, height: size.h * scale, overflow: 'hidden', margin: '0 auto' }
          : { width: 'max-content' }}
      >
        <div
          ref={sheetRef}
          className="ss-sheet w-max bg-white"
          style={{ padding: '1.5mm', transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <SetPreviewRow model={model} setIndex={setIndex} />
        </div>
      </div>
    </div>
  );
}

export default SetPreview;
