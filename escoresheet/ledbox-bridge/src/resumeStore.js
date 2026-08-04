// The "last game" slot — ONE in-progress match per sport, so an interrupted evening can be
// picked up where it stopped.
//
// Deliberately separate from historyStore.js, which archives FINISHED matches. This holds the
// live scoreboard state, rewritten as the match progresses, and is dropped the moment the match
// is decided: a finished match belongs in the history, and offering to "continue" one that is
// already over is worse than offering nothing.
//
// Why it exists: the appliance restarts on every sport switch, and a hall power cut mid-set used
// to lose the score outright. Per-sport because the operator may run a volleyball match, switch
// the board to basketball for a second court, and come back.
//
// Like historyStore, a fault in here must NEVER affect scoring — callers wrap it in try/catch and
// every disk operation is best-effort.

import fs from 'node:fs'
import path from 'node:path'

const num = (v) => Number(v) || 0
// Prefer the FULL name: the short is what fits on the panel, but it defaults to a placeholder
// ("HOME"/"AWAY"/"A/A"), so trusting it first would label a KSCW match "HOME".
const name = (full, short, fallback) => String(full || short || fallback).trim() || fallback

export class ResumeStore {
  constructor({ file } = {}) {
    this.file = file || null
    this.games = {} // sport -> { state, savedAt, updatedAt }
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (data && typeof data.games === 'object' && data.games) this.games = data.games
    } catch { /* no file yet / unreadable -> nothing to resume */ }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ games: this.games }))
    } catch { /* best-effort persistence */ }
  }

  // Is there anything here worth coming back to? A board sitting at 0-0 with nothing typed is not
  // a game — without this, "Continue" would be offered after any stray tap on an empty board.
  //
  // Only the FULL names count as "named". The short names default to placeholders ("HOME"/"AWAY",
  // "A/A"), so counting those would make every untouched board look like a game — and since a
  // `reset` emits exactly such a board, each reset would overwrite the real saved match with an
  // empty one. That is precisely the match an operator resets in order to come back to.
  static worthKeeping(state) {
    if (!state) return false
    const played = num(state.points_a) || num(state.points_b) ||
      num(state.sets_won_a) || num(state.sets_won_b) ||
      (Array.isArray(state.set_results) && state.set_results.length > 0)
    const named = String(state.team_a_name || '').trim() || String(state.team_b_name || '').trim()
    return !!(played || named)
  }

  // `now` is a preformatted stamp passed in by the caller, so this module stays deterministic.
  save(sport, state, now) {
    if (!sport) return false
    if (!ResumeStore.worthKeeping(state)) return false
    const prev = this.games[sport]
    this.games[sport] = {
      state,
      savedAt: (prev && prev.savedAt) || now, // when this game STARTED being tracked
      updatedAt: now,
    }
    this._save()
    return true
  }

  get(sport) {
    const g = this.games[sport]
    return g && g.state ? g.state : null
  }

  has(sport) {
    return !!this.get(sport)
  }

  clear(sport) {
    if (!this.games[sport]) return false
    delete this.games[sport]
    this._save()
    return true
  }

  // Small digest for the "continue or start over?" menu — enough for an operator to recognise
  // the match without loading the whole state into the page.
  summary(sport) {
    const g = this.games[sport]
    if (!g || !g.state) return null
    const s = g.state
    return {
      savedAt: g.savedAt,
      updatedAt: g.updatedAt,
      teams: { a: name(s.team_a_name, s.team_a_short, 'A'), b: name(s.team_b_name, s.team_b_short, 'B') },
      points: { a: num(s.points_a), b: num(s.points_b) },
      sets: { a: num(s.sets_won_a), b: num(s.sets_won_b) },
      setsPlayed: Array.isArray(s.set_results) ? s.set_results.length : 0,
    }
  }
}
