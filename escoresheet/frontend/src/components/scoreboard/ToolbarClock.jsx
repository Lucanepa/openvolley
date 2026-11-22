import { useEffect, useState } from 'react'
import { useInAppViewOpen } from '../../hooks/useInAppViewOpen'

// The options of toLocaleDateString / toLocaleTimeString the clock had, made
// once: the same text, without building two formatters every second
const DAY = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

/**
 * Date and time apart, joined by a space: toLocaleString puts a comma
 * between them ("08/11/2026, 09:51:10", Point Hub board 2026-11-08).
 */
export function formatToolbarClock (date) {
  return `${DAY.format(date)} ${TIME.format(date)}`
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
