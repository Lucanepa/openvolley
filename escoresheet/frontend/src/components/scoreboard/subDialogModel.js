/**
 * The SUB box's substitution dialog (owner 23.11.2026), as a model: who may
 * come in, who he may replace, and the pairs waiting for Confirm. Pure: no
 * React.
 *
 * The rules are NOT here. `legalIns` is the Scoreboard's own list for each
 * player on court (getAvailableSubstitutes, the court menu's and drag and
 * drop's: the libero, the forced starter-substitute pairs, completed
 * substitutions, a player with no rally since he came in, the 6 already made,
 * FIVB 15.5-15.8, 19.3.1.3). This only adds what a dialog of several pairs
 * needs on top: a player is in one pair at most, and the set never goes past
 * the 6 (`max`) with the pairs that wait.
 */

/**
 * The court as the scoring screen draws it (Scoreboard.jsx rightPositions /
 * leftPositions), as rows of two with the front row by the net: the team on
 * the right has the net on its left (II I / III VI / IV V), the team on the
 * left on its right (V IV / VI III / I II).
 */
export const SUB_DIALOG_COURT = {
  right: ['II', 'I', 'III', 'VI', 'IV', 'V'],
  left: ['V', 'IV', 'VI', 'III', 'I', 'II']
}

const str = (v) => (v === undefined || v === null ? '' : String(v))

/**
 * @param {object} args
 * @param {Array<{position:string, number:any, isLibero?:boolean}>} args.court the six on court now
 * @param {Array<{number:any}>} args.bench the bench players (no liberos), in the order to show them
 * @param {Record<string, Array<any>>} args.legalIns court number -> the bench numbers that may come in for him
 * @param {number} args.made the regular substitutions recorded in the set
 * @param {number} [args.max] 6 (FIVB 15.6)
 * @param {Array<{in:any, out:any}>} [args.pending] the pairs waiting for Confirm
 * @returns {{ total:number, canAdd:boolean, full:boolean, ins:Array, outsFor:(n:any)=>string[], courtNow:Array, busy:Set<string> }}
 *   total: made + pending; canAdd: another pair fits; full: the 6 are recorded;
 *   ins: the bench players who may come in now (each with someone to replace);
 *   outsFor: the court numbers the bench player may replace now;
 *   courtNow: the court with the waiting pairs in (the incoming player at the
 *   position, `incoming: true`)
 */
export function subDialogModel({ court = [], bench = [], legalIns = {}, made = 0, max = 6, pending = [] }) {
  const busy = new Set()
  for (const p of pending) {
    busy.add(str(p.in))
    busy.add(str(p.out))
  }
  const total = made + pending.length
  const canAdd = total < max
  const onCourt = court.filter(c => str(c.number) !== '' && !c.isLibero && !busy.has(str(c.number)))
  const outsFor = (inNumber) => {
    const n = str(inNumber)
    if (!canAdd || n === '' || busy.has(n)) return []
    return onCourt
      .filter(c => (legalIns[str(c.number)] || []).some(x => str(x) === n))
      .map(c => str(c.number))
  }
  const ins = canAdd ? bench.filter(b => outsFor(b.number).length > 0) : []
  const courtNow = court.map(c => {
    const pair = pending.find(p => str(p.out) !== '' && str(p.out) === str(c.number))
    if (!pair) return c
    const incoming = bench.find(b => str(b.number) === str(pair.in))
    return { ...c, number: str(pair.in), isCaptain: !!incoming?.isCaptain, incoming: true }
  })
  return { total, canAdd, full: made >= max, ins, outsFor, courtNow, busy }
}
