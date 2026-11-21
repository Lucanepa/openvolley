/**
 * The correction board's draft (owner 2026-11-20: "the scoreboard with
 * correction capabilities, more or less like DataProject"): the match as it
 * would be after the changes staged so far. Pure, no React, no Dexie.
 *
 * Every change is planned by the planners of domain/manualCorrections on the
 * draft the changes before it made, so the plans chain (mergePlans: "b planned
 * on the events after a"). Nothing is written while the scorer works: Confirm
 * hands combinedPlan() to services/corrections/applyCorrectionPlan, which
 * writes it in one transaction with one correction-log entry per change
 * (plan.logs). Cancel throws the steps away.
 *
 * A step is { plan } (a planner's plan, never one with `error`). Only the
 * last step is taken back (Undo): every later plan was planned on the draft
 * the earlier ones made.
 */
import { emptyPlan, mergePlans, applyPlanToEvents, planAddPoint, planRemovePoint } from './manualCorrections'
import { matchIssues } from './recompute'
import { remarksAfter } from './remarks'
import { scoreFromPointEvents } from './rules'

/**
 * The match before any staged change.
 * @param {{ events?: any[], match?: object, sets?: any[], players?: { home?: any[], away?: any[] } }} base
 */
export function baseDraft({ events = [], match = {}, sets = [], players = {} } = {}) {
  return {
    events: [...(events || [])],
    match: { ...(match || {}) },
    sets: [...(sets || [])],
    players: { home: [...(players?.home || [])], away: [...(players?.away || [])] }
  }
}

/** The draft after one more plan: events, match row (patch, remarks), set rows, rosters. */
export function applyStep(draft, plan) {
  const events = applyPlanToEvents(draft.events, plan)
  const match = { ...draft.match, ...(plan.matchPatch || {}) }
  const remarks = remarksAfter(draft.match?.remarks, plan)
  if (remarks !== (draft.match?.remarks || '')) match.remarks = remarks
  const affected = new Set(plan.affectedSets || [])
  const sets = (draft.sets || []).map(row => {
    let next = row
    if (affected.has(row.index)) next = { ...next, ...scoreFromPointEvents(events, row.index) }
    for (const su of plan.setUpdates || []) if (su.setIndex === row.index) next = { ...next, ...su.changes }
    return next
  })
  let players = draft.players
  if (plan.playerUpdates?.length) {
    const byId = new Map(plan.playerUpdates.filter(u => u?.id != null).map(u => [u.id, u.changes]))
    const upd = (list) => (list || []).map(p => (byId.has(p.id) ? { ...p, ...byId.get(p.id) } : p))
    players = { home: upd(draft.players?.home), away: upd(draft.players?.away) }
  }
  return { events, match, sets, players }
}

/** The draft after every step. */
export function buildDraft(base, steps = []) {
  return (steps || []).reduce((draft, step) => applyStep(draft, step.plan), base)
}

/**
 * The one plan Confirm writes: the steps merged in order, one log per step
 * (plan.logs), the remarks as the final text (a line edited in place in one
 * step and another appended in the next would not merge as lists).
 */
export function combinedPlan(base, steps = []) {
  let out = emptyPlan()
  const logs = []
  for (const step of steps || []) {
    out = mergePlans(out, step.plan)
    if (step.plan?.log) logs.push(step.plan.log)
  }
  const draft = buildDraft(base, steps)
  const before = base.match?.remarks || ''
  const after = draft.match?.remarks || ''
  out.remarkAdd = []
  out.remarkRemove = []
  out.remarkReplace = []
  delete out.remarksSet
  if (after !== before) out.remarksSet = after
  // the match row: only the fields that end up different
  if (out.matchPatch) {
    const patch = {}
    for (const [k, v] of Object.entries(out.matchPatch)) {
      if (k === 'remarks') continue
      if (JSON.stringify(v) !== JSON.stringify(base.match?.[k])) patch[k] = v
    }
    if (Object.keys(patch).length) out.matchPatch = patch
    else delete out.matchPatch
  }
  out.logs = logs
  out.log = logs.length ? logs[logs.length - 1] : null
  // the board gives a sanction's penalty point itself (a step of its own)
  out.followUp = null
  return out
}

/**
 * What the draft's record says that no longer fits and the match did not
 * already say (the panel's "Check these entries", for the staged changes).
 */
export function newIssues(base, draft, ctx = {}) {
  const known = new Set(matchIssues(base.events, { ...ctx, match: base.match }).map(i => i.sig))
  return matchIssues(draft.events, { ...ctx, match: draft.match }).filter(i => !known.has(i.sig))
}

/** The sentences of the staged changes, in order (the board's change list). */
export function stepLines(steps = []) {
  return (steps || []).map((s, i) => ({ index: i, text: s.plan?.log?.text || '', notes: s.plan?.notes || [] })).filter(l => l.text)
}

/**
 * A score typed on the board (owner 2026-11-21: "if possible yes"): the
 * difference as points of `team` at the end of the set, one after the other,
 * each planned on the draft the one before made (planAddPoint /
 * planRemovePoint, as "+" and "−"). Points of one team in a row: the first may
 * be a side-out (the team rotates), the next ones are on its own serve. It
 * stops at the first point the board cannot add or remove (the one that ends
 * the set, a finished set's rule) and says why.
 * @returns {{ plans: object[], reached: number, error: object|null }}
 */
export function planScoreTo(draft, { setIndex, team, target } = {}, ctx = {}) {
  const pointsOf = (d) => {
    const sc = scoreFromPointEvents(d.events, setIndex)
    return team === 'home' ? sc.homePoints : sc.awayPoints
  }
  const plans = []
  let d = draft
  let now = pointsOf(d)
  const goal = Number(target)
  if (!Number.isInteger(goal) || goal < 0) return { plans, reached: now, error: { error: 'corrections.error.noScoreChange', params: {} } }
  while (now !== goal) {
    const c = { ...ctx, match: d.match }
    const plan = goal > now
      ? planAddPoint(d.events, d.sets, { setIndex, team }, c)
      : planRemovePoint(d.events, d.sets, { setIndex, team }, c)
    if (plan.error) return { plans, reached: now, error: plan }
    plans.push(plan)
    d = applyStep(d, plan)
    const next = pointsOf(d)
    if (next === now) break // nothing moved: never loop
    now = next
  }
  return { plans, reached: now, error: null }
}
