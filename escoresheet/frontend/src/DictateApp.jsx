// app.openvolley.app/dictate — Swiss Volley's eScoresheet Diktat #1 as a
// dictation for the OpenVolley test match: the video (EN/DE, original or with
// three exceptional substitutions), every step in sync with it, and the end
// result as OpenVolley writes it.
//
// The videos and the result sheets are on R2 (openvolley-media.openvolley.app,
// bucket openvolley-media/dictate/): Pages takes no file over 25 MiB. The step
// lists (public/dictate/*.json) are built from the same cards as the videos
// (~/ov-ops/diktat-video/gen_page_data.py). The script itself is Swiss Volley's:
// linked, not copied.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FileText, Play } from 'lucide-react'
import { ReadingPage } from './ui/ReadingPage.jsx'
import { ReadingHeader } from './ui/PageHeader.jsx'
import { Card, CardHeading } from './ui/Card.jsx'
import { SegmentedControl } from './ui/SegmentedControl.jsx'
import { SectionHeader } from './ui/SectionHeader.jsx'
import { cn } from './ui/cn.js'

const LOGO = '/openvolley_logo.png'
const MEDIA = 'https://openvolley-media.openvolley.app/dictate'
const SWISS_VOLLEY_PDF = 'https://www.volleyball.ch/_Resources/Persistent/d/7/9/2/d792c82c4b1dab3b32915185823cd3c24c4d543c/eScoresheet-Diktat-%231_2021-09-13_v5.0.pdf'
const SWISS_VOLLEY_PAGE = 'https://www.volleyball.ch/de/ausbildung/schiedsrichter-innen/schreiber-in-werden'

const TEAM = { ZUR: 'ZÜRICH', LUZ: 'LUZERN' }
const TEAM_COLOUR = { ZUR: '#3b82f6', LUZ: '#dc2626' } // the test match's team colours (testSeeds.js)
const SETS = [[13, 25], [27, 25], [25, 13], [23, 25], [18, 16]]

// The page's own words, in the two languages of the videos (fr/it read English)
const TEXT = {
  en: {
    kicker: 'OpenVolley · test match',
    title: 'Diktat #1 to score along',
    lead: "Swiss Volley's eScoresheet Diktat #1 as a dictation for the OpenVolley test match: play the video, score every step in OpenVolley, compare the score after each step and the end result.",
    language: 'Language',
    version: 'Version',
    original: 'Original',
    exceptional: 'With exceptional substitutions',
    exceptionalNote: 'Adds three exceptional substitutions in set 5: injury (LUZERN #9 → #4 at 15:16), expulsion (ZÜRICH #1 → #10) and disqualification (LUZERN #4 → #2), both at 16:16. Everything else is the same as the original.',
    chapters: 'Jump to',
    howTitle: 'Before you start',
    how: [
      'Open OpenVolley and start a test match from Home.',
      'TEST Team A = ZÜRICH (home), TEST Team B = LUZERN (away): the test rosters and benches already match the Diktat.',
      'Coin toss: LUZERN is Team A and starts on the left, ZÜRICH serves first.',
      'Pause the video whenever you need more time. Each step shows the score to check.'
    ],
    openApp: 'Open OpenVolley',
    steps: 'Steps',
    step: 'Step',
    set: 'Set',
    score: 'Score',
    resultTitle: 'End result',
    winner: 'ZÜRICH wins 3–2',
    resultSheet: 'OpenVolley scoresheet (PDF)',
    resultNote: 'The scoresheet OpenVolley wrote when this version was played through the app, step by step.',
    resultExc: 'On top of the original: the three exceptional substitutions are in the remarks, the expulsion of ZÜRICH #1 and the disqualification of LUZERN #4 under sanctions; exceptional substitutions do not count toward the 6.',
    source: 'Script: Swiss Volley, eScoresheet Diktat #1 (v5.0, 13.09.2021)',
    sourcePdf: 'Official Diktat (PDF)',
    sourcePage: 'Swiss Volley: becoming a scorer',
    voice: 'The voice is computer-generated.'
  },
  de: {
    kicker: 'OpenVolley · Testspiel',
    title: 'Diktat #1 zum Mitschreiben',
    lead: 'Das eScoresheet-Diktat #1 von Swiss Volley als Diktat für das OpenVolley-Testspiel: Video abspielen, jeden Schritt in OpenVolley erfassen, den Spielstand nach jedem Schritt und das Endresultat vergleichen.',
    language: 'Sprache',
    version: 'Version',
    original: 'Original',
    exceptional: 'Mit ausserordentlichen Auswechslungen',
    exceptionalNote: 'Fügt in Satz 5 drei ausserordentliche Auswechslungen ein: Verletzung (LUZERN #9 → #4 bei 15:16), Ausschluss (ZÜRICH #1 → #10) und Disqualifikation (LUZERN #4 → #2), beide bei 16:16. Alles andere ist wie im Original.',
    chapters: 'Springe zu',
    howTitle: 'Bevor du startest',
    how: [
      'Öffne OpenVolley und starte auf Home ein Testspiel.',
      'TEST Team A = ZÜRICH (Heim), TEST Team B = LUZERN (Gast): Kader und Bänke des Testspiels stimmen schon mit dem Diktat überein.',
      'Auslosung: LUZERN ist Team A und beginnt links, ZÜRICH hat den ersten Aufschlag.',
      'Halte das Video an, wenn du mehr Zeit brauchst. Jeder Schritt zeigt den Spielstand zum Kontrollieren.'
    ],
    openApp: 'OpenVolley öffnen',
    steps: 'Schritte',
    step: 'Schritt',
    set: 'Satz',
    score: 'Stand',
    resultTitle: 'Endresultat',
    winner: 'ZÜRICH gewinnt 3:2',
    resultSheet: 'OpenVolley-Matchblatt (PDF)',
    resultNote: 'Das Matchblatt, das OpenVolley geschrieben hat, als diese Version Schritt für Schritt in der App gespielt wurde.',
    resultExc: 'Zusätzlich zum Original: die drei ausserordentlichen Auswechslungen stehen in den Bemerkungen, der Ausschluss von ZÜRICH #1 und die Disqualifikation von LUZERN #4 bei den Sanktionen; ausserordentliche Auswechslungen zählen nicht zu den 6.',
    source: 'Diktat: Swiss Volley, eScoresheet-Diktat #1 (v5.0, 13.09.2021)',
    sourcePdf: 'Offizielles Diktat (PDF)',
    sourcePage: 'Swiss Volley: Schreiber:in werden',
    voice: 'Die Stimme ist computergeneriert.'
  }
}

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

/** The index of the row playing at time `t` (rows sorted by start time). */
function rowAt(rows, t) {
  let lo = 0
  let hi = rows.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid][0] <= t + 0.05) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

export default function DictateApp() {
  const { i18n } = useTranslation()
  const startLang = String(i18n.resolvedLanguage || i18n.language || '').startsWith('de') ? 'de' : 'en'
  const [lang, setLang] = useState(startLang)
  const [version, setVersion] = useState(() => (new URLSearchParams(window.location.search).get('v') === 'exceptional' ? 'exc' : 'orig'))
  const [data, setData] = useState(null)
  const [now, setNow] = useState(0)
  const videoRef = useRef(null)
  const listRef = useRef(null)
  const T = TEXT[lang]
  const key = `${version}_${lang}`

  useEffect(() => { document.documentElement.lang = lang }, [lang])

  useEffect(() => {
    let alive = true
    setData(null)
    setNow(0)
    fetch(`/dictate/${key}.json`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (alive) setData(d) })
      .catch(() => { if (alive) setData({ rows: [], chapters: [], failed: true }) })
    return () => { alive = false }
  }, [key])

  const current = useMemo(() => (data?.rows?.length ? rowAt(data.rows, now) : -1), [data, now])

  // Keep the playing step in view inside the list (scrolls the list, not the page)
  useEffect(() => {
    const list = listRef.current
    const el = list?.querySelector(`[data-row="${current}"]`)
    if (!list || !el) return
    const top = el.offsetTop - list.offsetTop
    if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - el.offsetHeight) {
      list.scrollTop = Math.max(0, top - list.clientHeight / 3)
    }
  }, [current])

  const seek = (t) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = t + 0.05
    v.play?.().catch(() => {})
  }

  const videoSrc = `${MEDIA}/diktat-1${version === 'exc' ? '_exceptional' : ''}_${lang}.mp4`
  const resultBase = `${MEDIA}/result_${version}`

  // .ov-kit: the kit's own preflight, so the legacy element rules (green
  // buttons, muted paragraphs) stay off this page (tailwind.css)
  return (
    <div className="ov-kit">
    <ReadingPage width="5xl">
      <ReadingHeader
        kicker={T.kicker}
        title={T.title}
        logo={<img src={LOGO} alt="OpenVolley" className="h-9 sm:h-11 w-auto" />}
      />
      <p className="mb-6 max-w-3xl text-sm text-stone-600">{T.lead}</p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SegmentedControl
          variant="pill"
          ariaLabel={T.language}
          value={lang}
          onChange={setLang}
          options={[{ value: 'de', label: 'DE' }, { value: 'en', label: 'EN' }]}
        />
        <SegmentedControl
          ariaLabel={T.version}
          value={version}
          onChange={setVersion}
          options={[{ value: 'orig', label: T.original }, { value: 'exc', label: T.exceptional }]}
        />
      </div>
      {version === 'exc' && <p className="mb-4 max-w-3xl text-xs text-stone-500">{T.exceptionalNote}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div>
          <Card pad="flush" className="overflow-hidden">
            <video
              key={videoSrc}
              ref={videoRef}
              src={videoSrc}
              controls
              preload="metadata"
              playsInline
              className="block aspect-video w-full bg-stone-900"
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              onSeeked={(e) => setNow(e.currentTarget.currentTime)}
            />
            {data?.chapters?.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 p-3">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{T.chapters}</span>
                {data.chapters.map(c => (
                  <button
                    key={`${c.t}-${c.title}`}
                    type="button"
                    onClick={() => seek(c.t)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-stone-200 px-2.5 text-xs text-stone-600 transition-colors hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                  >
                    <Play size={12} aria-hidden="true" />
                    <span>{c.title}</span>
                    <span className="tabular-nums text-stone-400">{clock(c.t)}</span>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeading title={T.howTitle} />
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-stone-700">
              {T.how.map(line => <li key={line}>{line}</li>)}
            </ol>
            <a
              href="/"
              className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 focus-visible:ring-offset-1"
            >
              {T.openApp}
            </a>
          </Card>
        </div>

        <Card pad="flush">
          <div className="px-4 pt-4 sm:px-5">
            <SectionHeader title={T.steps} count={data?.rows?.length || undefined} />
          </div>
          <div ref={listRef} className="relative max-h-[70vh] overflow-y-auto px-2 pb-2 sm:px-3">
            {!data && <p className="p-3 text-sm text-stone-500">…</p>}
            {data?.rows?.map((r, i) => {
              const [t, step, set, team, kind, title, hint, zur, luz] = r
              const playing = i === current
              const label = team ? title.replace(`${TEAM[team]}: `, '').replace(` · ${TEAM[team]}`, '').replace(` ${TEAM[team]}`, '') : title
              return (
                <button
                  key={`${i}-${step}`}
                  data-row={i}
                  type="button"
                  onClick={() => seek(t)}
                  aria-current={playing ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-start gap-3 border-l-2 px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-400/60',
                    playing ? 'border-red-600 bg-stone-100' : 'border-transparent hover:bg-stone-50',
                    i > 0 && 'border-t border-t-stone-100'
                  )}
                >
                  <span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-stone-400">
                    {kind === 'set' || kind === 'end' ? `${T.set} ${set}` : step}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {team && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-stone-600">
                          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: TEAM_COLOUR[team] }} />
                          {TEAM[team]}
                        </span>
                      )}
                      <span className={cn('text-sm', kind === 'rally' ? 'text-stone-700' : 'font-semibold text-stone-900', kind === 'exc' && 'text-red-700')}>{label}</span>
                    </span>
                    {hint && <span className="mt-0.5 block text-xs text-stone-500">{hint}</span>}
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-stone-700" title={T.score}>{zur}:{luz}</span>
                </button>
              )
            })}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeading title={T.resultTitle} strong />
        <div className="mt-3 flex flex-wrap items-start gap-6">
          <div>
            <table className="text-sm tabular-nums">
              <thead>
                <tr className="text-[11px] font-bold uppercase tracking-wide text-stone-500">
                  <th className="pr-4 text-left font-bold">{T.set}</th>
                  <th className="pr-4 text-right font-bold">ZÜRICH</th>
                  <th className="text-right font-bold">LUZERN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {SETS.map(([z, l], i) => (
                  <tr key={i}>
                    <td className="py-1 pr-4 text-stone-500">{i + 1}</td>
                    <td className={cn('py-1 pr-4 text-right', z > l ? 'font-bold text-stone-900' : 'text-stone-600')}>{z}</td>
                    <td className={cn('py-1 text-right', l > z ? 'font-bold text-stone-900' : 'text-stone-600')}>{l}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm font-semibold text-stone-900">{T.winner}</p>
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-sm text-stone-600">
            <p>{T.resultNote}</p>
            {version === 'exc' && <p>{T.resultExc}</p>}
            <a
              href={`${resultBase}.pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-200 px-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              <FileText size={15} aria-hidden="true" /> {T.resultSheet}
            </a>
          </div>
        </div>
        <a href={`${resultBase}.pdf`} target="_blank" rel="noopener noreferrer" className="mt-4 block">
          <img
            src={`${resultBase}.jpg`}
            alt={T.resultSheet}
            loading="lazy"
            className="w-full rounded-xl border border-stone-200"
          />
        </a>
      </Card>

      <footer className="mt-6 space-y-1 text-xs text-stone-500">
        <p>{T.source} · {T.voice}</p>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          <a href={SWISS_VOLLEY_PDF} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-stone-700">
            {T.sourcePdf} <ExternalLink size={11} aria-hidden="true" />
          </a>
          <a href={SWISS_VOLLEY_PAGE} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-stone-700">
            {T.sourcePage} <ExternalLink size={11} aria-hidden="true" />
          </a>
        </p>
      </footer>
    </ReadingPage>
    </div>
  )
}
