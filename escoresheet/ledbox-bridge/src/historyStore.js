// Records completed matches for the History tab + CSV/JSON export (and, later, a
// live-scoring feed for wiedisync). Deliberately isolated: a fault in here must NEVER
// affect scoring, so controlServer wraps record() in try/catch. Persisted to a JSON
// file so the log survives a bridge restart.

import fs from 'node:fs'
import path from 'node:path'

const MAX_MATCHES = 100 // keep the last N completed matches
const MAX_EVENTS = 4000 // per-match event cap (a long 5-setter is ~250 rallies)

const num = (v) => (Array.isArray(v) ? v.length : Number(v) || 0)

export class HistoryStore {
  constructor({ file } = {}) {
    this.file = file || null
    this.matches = [] // completed matches, oldest-first on disk; API returns newest-first
    this.current = null // in-progress match buffer
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(data.matches)) this.matches = data.matches
    } catch { /* no file yet / unreadable -> start empty */ }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ matches: this.matches }))
    } catch { /* best-effort persistence */ }
  }

  _teams(state) {
    return {
      a: state.team_a_short || state.team_a_name || 'A',
      b: state.team_b_short || state.team_b_name || 'B',
    }
  }

  // Feed every applied action + the resulting state + the notable event. `now` is a
  // preformatted timestamp string (passed in so this module stays deterministic/testable).
  record(action, state, event, now) {
    if (!action || !state) return
    const t = action.type
    // A new match begins on reset, or on the first scoring action when nothing is buffered.
    if (t === 'reset') { this.current = null; return }
    const scoring = t === 'point' || t === 'set' || t === 'timeout' || t === 'sub' || t === 'serve'
    if (!this.current && scoring) {
      const nm = this._teams(state)
      this.current = { date: now, team_a: nm.a, team_b: nm.b, events: [] }
    }
    if (!this.current) return
    // Keep names fresh — the operator often types them after the first point.
    const nm = this._teams(state)
    this.current.team_a = nm.a
    this.current.team_b = nm.b
    if (t === 'point' && Number(action.delta) > 0) {
      this._push({ t: now, type: 'point', side: action.side === 'right' ? 'b' : 'a',
        score: [num(state.points_a), num(state.points_b)] })
    }
    if (event === 'set-end') {
      const r = (state.set_results || []).slice(-1)[0] || { a: num(state.points_a), b: num(state.points_b) }
      this._push({ t: now, type: 'set-end', set: num(state.sets_won_a) + num(state.sets_won_b),
        score: [num(r.a), num(r.b)] })
    } else if (event === 'match-end') {
      this._push({ t: now, type: 'match-end', score: [num(state.points_a), num(state.points_b)] })
      this._finish(state, now)
    }
  }

  _push(ev) {
    if (this.current.events.length < MAX_EVENTS) this.current.events.push(ev)
  }

  _finish(state, now) {
    const sets = (state.set_results || []).map((r) => ({ a: num(r.a), b: num(r.b) }))
    this.matches.push({
      date: this.current.date || now,
      team_a: this.current.team_a, team_b: this.current.team_b,
      sets_a: num(state.sets_won_a), sets_b: num(state.sets_won_b),
      sets, events: this.current.events,
    })
    if (this.matches.length > MAX_MATCHES) this.matches = this.matches.slice(-MAX_MATCHES)
    this.current = null
    this._save()
  }

  // API view — newest match first.
  list() { return { matches: this.matches.slice().reverse() } }

  clear() { this.matches = []; this.current = null; this._save() }
}
