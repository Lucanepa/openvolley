/**
 * Set and match times for the scoresheet (set headers, RESULT table) and the
 * in-app "Match complete" card (MatchEnd.jsx). The rules live in ONE plain-JS
 * module, src/domain/sheetTimes.js, which the server's public API uses too (a
 * byte-for-byte copy in backend/lib/sheetTimes.js). See there for the owner's
 * rules (field-spec 16).
 */
import {
  setStartMs as setStartMsJs,
  setEndMs as setEndMsJs,
  setDurationMinutes as setDurationMinutesJs,
  matchTimes as matchTimesJs,
  isoOf as isoOfJs
} from '../../src/domain/sheetTimes.js'

export interface TimedSet {
  index: number
  startTime?: string | null
  endTime?: string | null
  finished?: boolean
}

export interface TimedEvent {
  type?: string
  setIndex?: number
  seq?: number
  ts?: string | number | null
  payload?: { startTime?: string | null; firstRallyAt?: string | null } | null
}

/** The set's start (ms, to the minute), or null when nothing tells it. */
export const setStartMs: (set: TimedSet | null | undefined, events?: TimedEvent[]) => number | null = setStartMsJs

/** The set's end (ms, to the minute): the recorded end, else its last point. */
export const setEndMs: (set: TimedSet | null | undefined, events?: TimedEvent[]) => number | null = setEndMsJs

/** Whole minutes from the set's start to its end, or null. */
export const setDurationMinutes: (set: TimedSet | null | undefined, events?: TimedEvent[]) => number | null = setDurationMinutesJs

/** Match start (set 1's start), end (the last finished set's end) and duration in minutes. */
export const matchTimes: (
  sets: TimedSet[] | undefined,
  events?: TimedEvent[],
  opts?: { skip?: (set: TimedSet) => boolean }
) => { startMs: number | null; endMs: number | null; durationMinutes: number | null } = matchTimesJs

/** ISO string of a time in ms (for the local-time formatters), '' for null. */
export const isoOf: (n: number | null) => string = isoOfJs
