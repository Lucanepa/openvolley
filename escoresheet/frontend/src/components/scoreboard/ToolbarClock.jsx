import { useEffect, useState } from 'react'
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
  const { day, time, minutes } = currentFormatters()
  return `${day.format(date)} ${(seconds ? time : minutes).format(date)}`
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
 */
export default function ToolbarClock () {
  const covered = useInAppViewOpen()
  const { clockSeconds: seconds } = useLook()
  const [text, setText] = useState(() => formatToolbarClock(new Date(), { seconds }))
  useEffect(() => {
    if (covered) return undefined
    const tick = () => setText(formatToolbarClock(new Date(), { seconds })) // the same text renders nothing
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
  return text
}
