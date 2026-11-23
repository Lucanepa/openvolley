import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useInAppViewOpen } from '../../hooks/useInAppViewOpen'
import { useLook } from '../../utils/lookSettings'

// The options of toLocaleDateString / toLocaleTimeString the clock had
const DAY_OPTIONS = { year: 'numeric', month: '2-digit', day: '2-digit' }
const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
// Options › Effects and speed › Seconds on the clock off: hours and minutes
const MINUTES_OPTIONS = { hour: '2-digit', minute: '2-digit', hour12: false }

// The two formatters, made again when the device's time zone or language
// changes: a formatter keeps the zone it was made in, and the clock must
// follow the device as toLocaleTimeString does (Android sets the zone from
// the network a while after boot, with the app already open; the scorer can
// fix a wrong zone in Settings). Checked at every tick: one formatter's
// resolved options read, instead of two formatters built every second.
let formatters = null
function currentFormatters () {
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions()
  const key = `${locale}|${timeZone}`
  if (formatters?.key !== key) {
    formatters = {
      key,
      day: new Intl.DateTimeFormat(undefined, DAY_OPTIONS),
      time: new Intl.DateTimeFormat(undefined, TIME_OPTIONS),
      minutes: new Intl.DateTimeFormat(undefined, MINUTES_OPTIONS)
    }
  }
  return formatters
}

/**
 * Date and time apart, joined by a space: toLocaleString puts a comma
 * between them ("08/11/2026, 09:51:10", Point Hub board 2026-11-08).
 * seconds false: the time as HH:MM ("08/11/2026 09:51").
 */
export function formatToolbarClock (date, { seconds = true } = {}) {
  const { day, time } = toolbarClockParts(date, { seconds })
  return `${day} ${time}`
}

/** The date and the time of formatToolbarClock, each on its own. */
export function toolbarClockParts (date, { seconds = true } = {}) {
  const { day, time, minutes } = currentFormatters()
  return { day: day.format(date), time: (seconds ? time : minutes).format(date) }
}

export const MINUTE_MS = 60000

/**
 * ms from `now` to the next full minute (60000 on the minute itself). Every
 * time zone is a whole number of minutes from UTC, so the epoch's minutes are
 * the clock's.
 */
export function msToNextMinute (now) {
  return MINUTE_MS - (((now % MINUTE_MS) + MINUTE_MS) % MINUTE_MS)
}

/**
 * The date and time of the scoring screen's toolbar, ticking by itself. It
 * was Scoreboard state: each second rendered the whole scoring screen (and
 * any dialog open on it) to change this text. Under the Android in-app view
 * nobody sees it: it stops there and shows the time again at once when the
 * view closes. Without seconds (utils/lookSettings clockSeconds) it shows
 * HH:MM and ticks once a minute, on the minute: no redraw in between.
 *
 * The time sits in a box of a fixed size (styles.css .toolbar-clock-time,
 * contain: strict): a relayout boundary, so a tick lays out that box alone.
 * Without it every second laid out the whole page (44 ms a tick on the
 * emulated hall tablet, the largest idle cost left). The date stays plain
 * text before it, so a tight toolbar (large system font, the backup alert
 * beside the chevron) still puts the time under the date, as before. The box
 * is as wide as the time in any language (fr-CA writes "23 h 58 min 48 s"),
 * never cutting it.
 */
export default function ToolbarClock () {
  const covered = useInAppViewOpen()
  const { clockSeconds: seconds } = useLook()
  const [parts, setParts] = useState(() => toolbarClockParts(new Date(), { seconds }))
  const boxRef = useRef(null)
  useEffect(() => {
    if (covered) return undefined
    // the same text renders nothing
    const tick = () => {
      const next = toolbarClockParts(new Date(), { seconds })
      setParts((shown) => (shown.day === next.day && shown.time === next.time ? shown : next))
    }
    tick()
    if (seconds) {
      const timer = setInterval(tick, 1000)
      return () => clearInterval(timer)
    }
    // a timeout per minute, set again from the clock each time: a timer that
    // fires early ticks once more at the minute, one late shows it late once
    let timer = null
    const next = () => {
      timer = setTimeout(() => { tick(); next() }, msToNextMinute(Date.now()))
    }
    next()
    return () => clearTimeout(timer)
  }, [covered, seconds])
  // The box takes the time's own width (in em, so it follows the font size):
  // the clock is as wide as its text was without the box, and wraps where it
  // did. With tabular figures that width only changes with the format or the
  // font: then the box is resized once; every other tick only reads it, which
  // lays out the box alone (the layout the frame makes anyway). A hidden box
  // (the folded toolbar) measures 0 and keeps its width, or the stylesheet's
  // after a change of seconds.
  const fit = useCallback(() => {
    const box = boxRef.current
    if (!box?.firstChild) return
    const range = document.createRange()
    range.selectNodeContents(box)
    if (typeof range.getBoundingClientRect !== 'function') return
    const text = range.getBoundingClientRect().width
    if (!(text > 0) || Math.abs(text - box.getBoundingClientRect().width) < 0.02) return
    const px = parseFloat(getComputedStyle(box).fontSize)
    if (px > 0) box.style.width = `${Math.ceil(text * 64) / 64 / px}em`
  }, [])
  const fittedSeconds = useRef(seconds)
  useLayoutEffect(() => {
    if (fittedSeconds.current !== seconds && boxRef.current) {
      fittedSeconds.current = seconds
      boxRef.current.style.width = ''
    }
    fit()
  }, [parts.time, seconds, fit])
  // a web font that arrives later changes the width: fit again
  useEffect(() => {
    const fonts = document.fonts
    if (!fonts?.addEventListener) return undefined
    fonts.addEventListener('loadingdone', fit)
    return () => fonts.removeEventListener('loadingdone', fit)
  }, [fit])
  return (
    <>
      {parts.day}{' '}
      <span ref={boxRef} className="toolbar-clock-time" data-seconds={seconds ? undefined : 'off'}>{parts.time}</span>
    </>
  )
}
