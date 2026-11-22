import { useEffect, useState } from 'react'
import { useInAppViewOpen } from '../../hooks/useInAppViewOpen'

// The options of toLocaleDateString / toLocaleTimeString the clock had
const DAY_OPTIONS = { year: 'numeric', month: '2-digit', day: '2-digit' }
const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }

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
      time: new Intl.DateTimeFormat(undefined, TIME_OPTIONS)
    }
  }
  return formatters
}

/**
 * Date and time apart, joined by a space: toLocaleString puts a comma
 * between them ("08/11/2026, 09:51:10", Point Hub board 2026-11-08).
 */
export function formatToolbarClock (date) {
  const { day, time } = currentFormatters()
  return `${day.format(date)} ${time.format(date)}`
}

/**
 * The date and time of the scoring screen's toolbar, ticking by itself. It
 * was Scoreboard state: each second rendered the whole scoring screen (and
 * any dialog open on it) to change this text. Under the Android in-app view
 * nobody sees it: it stops there and shows the time again at once when the
 * view closes.
 */
export default function ToolbarClock () {
  const covered = useInAppViewOpen()
  const [text, setText] = useState(() => formatToolbarClock(new Date()))
  useEffect(() => {
    if (covered) return undefined
    const tick = () => setText(formatToolbarClock(new Date())) // the same text renders nothing
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [covered])
  return text
}
