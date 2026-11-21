// app.openvolley.app/dictate — based on Swiss Volley's eScoresheet dictation, a
// dictation for the OpenVolley test match: the video (EN/DE, original or with
// three exceptional substitutions), every step in sync with it, and the end
// result as OpenVolley writes it.
//
// The videos and the result sheets are on R2 (openvolley-media.openvolley.app,
// bucket openvolley-media/dictate/): Pages takes no file over 25 MiB. The step
// lists (public/dictate/*.json) are built from the same cards as the videos
// (~/ov-ops/diktat-video/gen_page_data.py). The script itself is Swiss Volley's:
// neither copied nor linked (owner 15.11.2026). The videos are silent; the
// printable step lists (our own wording) are on R2 too (dictate/print/).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Play, Printer } from 'lucide-react'
import { ReadingPage } from './ui/ReadingPage.jsx'
import { ReadingHeader } from './ui/PageHeader.jsx'
import { Card, CardHeading } from './ui/Card.jsx'
import { SegmentedControl } from './ui/SegmentedControl.jsx'
import { SectionHeader } from './ui/SectionHeader.jsx'
import { cn } from './ui/cn.js'
import { HOWTO } from './dictateHowto.js'

const LOGO = '/openvolley_logo.png'
// A changed media file gets a new name: the same name would be served
// from Cloudflare's edge cache (max-age 1 day)
const MEDIA = 'https://openvolley-media.openvolley.app/dictate'

// The dictation's teams as its videos and step lists name them (Swiss Volley's
// script: ZÜRICH and LUZERN). The test match plays them as the made-up
// VBC Musterau (MUS, home) and VC Beispielstadt (BSP, away): the "Before you
// start" lines say so, and the result sheets and how-to pictures (regenerated
// 20.11.2026 from a UI replay, ~/ov-ops/diktat-video/driver) show those names.
// New videos with the test match's names would come from ~/ov-ops/diktat-video
// (cards*.json, render.py).
const TEAM = { ZUR: 'ZÜRICH', LUZ: 'LUZERN' }
const TEAM_COLOUR = { ZUR: '#3b82f6', LUZ: '#dc2626' } // the test match's team colours (testSeeds.js)
const SETS = [[13, 25], [27, 25], [25, 13], [23, 25], [18, 16]]

// The page's own words, in the two languages of the videos (fr/it read English)
const TEXT = {
  en: {
    kicker: 'OpenVolley · test match',
    title: 'Dictation to score along',
    lead: "A dictation for the OpenVolley test match, based on Swiss Volley's eScoresheet dictation: play the video, score every step in OpenVolley, compare the score after each step and the end result.",
    language: 'Language',
    version: 'Version',
    original: 'Original',
    exceptional: 'With exceptional substitutions',
    exceptionalNote: 'Adds three exceptional substitutions in set 5: injury (LUZERN #9 → #4 at 15:16), expulsion (ZÜRICH #1 → #10) and disqualification (LUZERN #4 → #2), both at 16:16. Everything else is the same as the original.',
    chapters: 'Jump to',
    howTitle: 'Before you start',
    how: [
      'Open OpenVolley and start a test match from Home.',
      "The dictation's ZÜRICH is the test match's home team, VBC Musterau (MUS); its LUZERN is the away team, VC Beispielstadt (BSP). The test rosters and benches already match the dictation.",
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
    source: 'Based on Swiss Volley\'s eScoresheet dictation (v5.0, 13.09.2021). The video is silent: read the cards.',
    print: 'Printable step list (PDF)',
    howTitle2: 'How to enter the special steps',
    howLead: 'The steps that need more than a tap on Point, as OpenVolley shows them (screenshots of the English app). Tap a step number to jump there in the video.',
    excOnly: 'Version with exceptional substitutions',
    stepsAt: 'In the dictation'
  },
  de: {
    kicker: 'OpenVolley · Testspiel',
    title: 'Diktat zum Mitschreiben',
    lead: 'Ein Diktat für das OpenVolley-Testspiel, nach dem eScoresheet-Diktat von Swiss Volley: Video abspielen, jeden Schritt in OpenVolley erfassen, den Spielstand nach jedem Schritt und das Endresultat vergleichen.',
    language: 'Sprache',
    version: 'Version',
    original: 'Original',
    exceptional: 'Mit ausserordentlichen Auswechslungen',
    exceptionalNote: 'Fügt in Satz 5 drei ausserordentliche Auswechslungen ein: Verletzung (LUZERN #9 → #4 bei 15:16), Ausschluss (ZÜRICH #1 → #10) und Disqualifikation (LUZERN #4 → #2), beide bei 16:16. Alles andere ist wie im Original.',
    chapters: 'Springe zu',
    howTitle: 'Bevor du startest',
    how: [
      'Öffne OpenVolley und starte auf Home ein Testspiel.',
      'ZÜRICH im Diktat ist das Heimteam des Testspiels, VBC Musterau (MUS); LUZERN ist das Gastteam, VC Beispielstadt (BSP). Kader und Bänke des Testspiels stimmen schon mit dem Diktat überein.',
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
    source: 'Nach dem eScoresheet-Diktat von Swiss Volley (v5.0, 13.09.2021). Das Video ist stumm: lies die Karten.',
    print: 'Schrittliste zum Drucken (PDF)',
    howTitle2: 'So erfasst du die speziellen Schritte',
    howLead: 'Die Schritte, die mehr als einen Tipp auf Punkt brauchen, so wie OpenVolley sie zeigt (Screenshots der englischen App). Tippe auf eine Schrittnummer, um im Video dorthin zu springen.',
    excOnly: 'Version mit ausserordentlichen Auswechslungen',
    stepsAt: 'Im Diktat'
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

  const videoSrc = `${MEDIA}/diktat${version === 'exc' ? '_exceptional' : ''}_${lang}_silent.mp4`
  const printPdf = `${MEDIA}/print/diktat_${version}_${lang}.pdf`
  const rowOf = (step) => data?.rows?.find(r => r[1] === step)
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
            <a
              href={printPdf}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 ml-2 inline-flex h-11 items-center gap-2 rounded-xl border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
            >
              <Printer size={16} aria-hidden="true" /> {T.print}
            </a>
          </Card>
        </div>

        <Card pad="flush">
          <div className="px-4 pt-4 sm:px-5">
            <SectionHeader title={T.steps} count={data?.rows?.length || undefined} />
          </div>
          <div ref={listRef} className="relative max-h-[55vh] overflow-y-auto overscroll-contain px-2 pb-2 sm:px-3 lg:max-h-[70vh]">
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

      <section className="mt-6" aria-labelledby="dictate-howto">
        <h2 id="dictate-howto" className="text-lg font-bold text-stone-900">{T.howTitle2}</h2>
        <p className="mt-1 mb-4 max-w-3xl text-sm text-stone-600">{T.howLead}</p>
        {HOWTO.filter(h => version === 'exc' || !h.exc).map(h => {
          const tx = h[lang]
          return (
            <Card key={h.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-bold text-stone-900">{tx.title}</h3>
                {h.exc && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700">{T.excOnly}</span>}
              </div>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-700">
                {tx.do.map(line => <li key={line}>{line}</li>)}
              </ol>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{T.stepsAt}</span>
                {h.steps.map(st => {
                  const r = rowOf(st)
                  return (
                    <button
                      key={st}
                      type="button"
                      disabled={!r}
                      onClick={() => { if (r) { seek(r[0]); videoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }}
                      className="inline-flex h-7 items-center gap-1 rounded-lg border border-stone-200 px-2 text-xs tabular-nums text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
                    >
                      <Play size={10} aria-hidden="true" /> {st}
                    </button>
                  )
                })}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {h.shots.map(id => (
                  <a key={id} href={`${MEDIA}/howto/${id}.jpg`} target="_blank" rel="noopener noreferrer" className="block">
                    <img src={`${MEDIA}/howto/${id}.jpg`} alt={tx.title} loading="lazy" className="w-full rounded-lg border border-stone-200" />
                  </a>
                ))}
              </div>
            </Card>
          )
        })}
      </section>

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

      <footer className="mt-6 text-xs text-stone-500">
        <p>{T.source}</p>
      </footer>
    </ReadingPage>
    </div>
  )
}
