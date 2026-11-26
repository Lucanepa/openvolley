/**
 * Pure helpers of the bench's live view (MatchEntry): the counters' state,
 * their pips, the short team name the score card shows and the team's
 * sanctions list.
 */

/** Time-outs and substitutions a team has per set (FIVB 15.1). */
export const TIMEOUT_LIMIT = 2
export const SUBSTITUTION_LIMIT = 6

/**
 * The state of a TO / SUB counter: 'max' when the limit is used up, 'near'
 * one before it (only where that warns of something: the fifth substitution),
 * else null.
 * @param {number} used
 * @param {number} limit
 * @param {{ warnNear?: boolean }} [opts]
 * @returns {'max'|'near'|null}
 */
export function counterTone(used, limit, { warnNear = false } = {}) {
  const n = Number(used) || 0
  if (n >= limit) return 'max'
  if (warnNear && n === limit - 1) return 'near'
  return null
}

/**
 * One pip per allowed request, filled for each used: [true, false] for one
 * time-out of two. More used than allowed (a correction) fills them all.
 * @param {number} used
 * @param {number} limit
 * @returns {boolean[]}
 */
export function counterPips(used, limit) {
  const n = Math.max(0, Number(used) || 0)
  return Array.from({ length: limit }, (_, i) => i < n)
}

/**
 * A team's sanctions as the bench's sanctions box lists them: every sanction
 * event of the team in the match, once each, in the order of `events` (the
 * bench sorts them by seq). Read from the events alone, never from who is
 * on the court or the bench: a player, a libero or a bench player by shirt
 * number, a team official by role (also one the team's bench list does not
 * have), a delay sanction as "D" (also an old row with "D" as the number),
 * an improper request, a team sanction (Easy match) as "Team".
 * @param {object[]} events the match's events
 * @param {'home'|'away'} team
 * @returns {{ key: string, type: 'player'|'team', number?: string|number, role?: string, delay?: boolean, sanctionType: string }[]}
 */
export function teamSanctionsForDisplay(events, team) {
  const list = []
  const seen = new Set()
  for (const e of events || []) {
    if (e?.type !== 'sanction' || e.payload?.team !== team) continue
    const p = e.payload
    const sanctionType = p.type || p.sanctionType || 'warning'
    const n = p.playerNumber ?? p.player
    const hasNumber = n != null && n !== ''
    const delayMark = hasNumber && String(n).toUpperCase() === 'D'
    // The same event twice in a bundle is one item: by its id or seq, else
    // (a live-state projection has neither) by what it records
    const key = e.id != null ? `id:${e.id}`
      : e.seq != null ? `seq:${e.seq}`
        : JSON.stringify([e.setIndex ?? null, e.ts ?? null, p.playerType ?? null, hasNumber ? String(n) : null, p.role ?? null, sanctionType])
    if (seen.has(key)) continue
    seen.add(key)
    if (hasNumber && !delayMark && p.playerType !== 'official') {
      list.push({ key, type: 'player', number: n, sanctionType })
    } else {
      list.push({ key, type: 'team', role: p.role || 'Team', delay: delayMark, sanctionType })
    }
  }
  return list
}
