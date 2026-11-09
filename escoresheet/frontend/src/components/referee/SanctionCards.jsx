/**
 * Sanction cards on the referee tablet, drawn as the referee holds them
 * (FIVB rule 21.3): a yellow card (warning), a red card (penalty), the red
 * and yellow card together in one hand (expulsion) and the two apart, one in
 * each hand (disqualification). Real card proportions (about 2 : 3), rounded
 * corners, a dark edge and a thin white rim so a card reads on any shirt
 * colour, the court or the page. The same glyphs on the player discs and in
 * the sanctions panel (owner 2026-11-09: "more professional, like it was
 * before" — the referee court drew 14 x 20 px cards until 6425fcea shrank
 * them into a dark pill).
 */

/** The official card colours (not the brand red). */
export const CARD_YELLOW = '#facc15'
export const CARD_RED = '#dc2626'

/** Card width : height. */
export const CARD_ASPECT = 2 / 3

/** Severity on the misconduct sanction scale (rule 21.3). */
export const SANCTION_RANK = { warning: 1, penalty: 2, expulsion: 3, disqualification: 4 }

/** The most severe of a player's sanctions ({ warning, penalty, expulsion, disqualification } flags), or null. */
export function topSanction(flags = {}) {
  let top = null
  for (const kind of Object.keys(SANCTION_RANK)) if (flags?.[kind]) top = kind
  return top
}

/**
 * Width of a glyph, as a share of its height: one card, or the pair (the
 * second card overlaps the first by a third for an expulsion, stands apart
 * for a disqualification).
 */
export function glyphWidthShare(kind) {
  const w = CARD_ASPECT
  if (kind === 'expulsion') return w + w * 0.62
  if (kind === 'disqualification') return w * 2 + w * 0.22
  return w
}

const cardStyle = (color, height, extra = {}) => ({
  display: 'block',
  boxSizing: 'border-box',
  width: `calc(${height} * ${CARD_ASPECT.toFixed(4)})`,
  height,
  background: color,
  borderRadius: `calc(${height} * 0.12)`,
  border: '1px solid rgba(0, 0, 0, 0.45)',
  boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.85), 0 1px 3px rgba(0, 0, 0, 0.35)',
  flexShrink: 0,
  ...extra
})

const KIND_LABEL = {
  warning: 'Warning',
  penalty: 'Penalty',
  expulsion: 'Expulsion',
  disqualification: 'Disqualification'
}

/**
 * One sanction as cards.
 * @param {object} props
 * @param {'warning'|'penalty'|'expulsion'|'disqualification'} props.kind
 * @param {string} props.height a CSS length (px, var(), calc())
 * @param {string} [props.title] accessible name (defaults to the English kind)
 */
export function CardGlyph({ kind, height, title }) {
  const name = title || KIND_LABEL[kind] || kind
  if (kind === 'expulsion') {
    // red and yellow together, fanned in one hand
    return (
      <span data-card-glyph={kind} role="img" aria-label={name} title={name} style={{ position: 'relative', display: 'inline-block', flexShrink: 0, height, width: `calc(${height} * ${glyphWidthShare(kind).toFixed(4)})` }}>
        <span style={cardStyle(CARD_YELLOW, height, { position: 'absolute', left: 0, top: 0, transform: 'rotate(-8deg)', transformOrigin: '50% 90%' })} />
        <span style={cardStyle(CARD_RED, height, { position: 'absolute', right: 0, top: 0, transform: 'rotate(8deg)', transformOrigin: '50% 90%' })} />
      </span>
    )
  }
  if (kind === 'disqualification') {
    // red and yellow apart, one in each hand
    return (
      <span data-card-glyph={kind} role="img" aria-label={name} title={name} style={{ display: 'inline-flex', alignItems: 'center', gap: `calc(${height} * ${(CARD_ASPECT * 0.22).toFixed(4)})`, flexShrink: 0, height }}>
        <span style={cardStyle(CARD_YELLOW, height)} />
        <span style={cardStyle(CARD_RED, height)} />
      </span>
    )
  }
  return <span data-card-glyph={kind} role="img" aria-label={name} title={name} style={cardStyle(kind === 'penalty' ? CARD_RED : CARD_YELLOW, height)} />
}

/**
 * One team's sanctions as a list of cards with who got them (shirt number,
 * or the bench member's role), in the order of the scale: warnings,
 * penalties, expulsions, disqualifications, then the delay sanctions (a card
 * with "D", the scoresheet's mark for a delay). Above them the team's state:
 * its formal warning used, an improper request.
 *
 * @param {object} props
 * @param {{ formalWarning: boolean, improperRequest: boolean, delayWarning: boolean, delayPenalty: boolean, warnings: {id: any}[], penalties: {id: any}[], expulsions: {id: any}[], disqualifications: {id: any}[] }} props.sanctions
 * @param {(key: string, fallback: string) => string} props.t
 * @param {string} [props.cardHeight] CSS length of a card (default 22px)
 * @param {'row'|'column'} [props.flow] wrap the items along a row (portrait strip) or stack them (side panel)
 */
export function TeamSanctionList({ sanctions, t, cardHeight = '22px', flow = 'row' }) {
  const s = sanctions || {}
  const items = [
    ...(s.warnings || []).map((x) => ({ kind: 'warning', who: x.id })),
    ...(s.penalties || []).map((x) => ({ kind: 'penalty', who: x.id })),
    ...(s.expulsions || []).map((x) => ({ kind: 'expulsion', who: x.id })),
    ...(s.disqualifications || []).map((x) => ({ kind: 'disqualification', who: x.id })),
    ...(s.delayWarning ? [{ kind: 'warning', who: 'D', delay: true }] : []),
    ...(s.delayPenalty ? [{ kind: 'penalty', who: 'D', delay: true }] : [])
  ]
  const kindName = {
    warning: t('scoreboard.sanctions.warning', 'Warning'),
    penalty: t('scoreboard.sanctions.penalty', 'Penalty'),
    expulsion: t('scoreboard.sanctions.expulsion', 'Expulsion'),
    disqualification: t('scoreboard.sanctions.disqualification', 'Disqualification')
  }
  const delayName = { warning: t('scoreboard.sanctions.delayWarning', 'Delay warning'), penalty: t('scoreboard.sanctions.delayPenalty', 'Delay penalty') }
  const empty = items.length === 0 && !s.formalWarning && !s.improperRequest
  return (
    <div data-team-sanctions="" style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {(s.formalWarning || s.improperRequest) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: flow === 'row' ? 'flex-start' : 'center' }}>
          {s.formalWarning && (
            <span data-team-state="formal-warning" style={teamStateChip}>
              <CardGlyph kind="warning" height="12px" title={t('refereeDashboard.sanctions.formalWarning', 'Formal warning')} />
              {t('refereeDashboard.sanctions.formalWarning', 'Formal warning')}
            </span>
          )}
          {s.improperRequest && (
            <span data-team-state="improper-request" style={teamStateChip}>
              {t('scoreboard.sanctions.improperRequest', 'Improper request')}
            </span>
          )}
        </div>
      )}
      {items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: flow === 'row' ? 'row' : 'column', flexWrap: 'wrap', gap: flow === 'row' ? '6px 12px' : 6, alignItems: flow === 'row' ? 'center' : 'flex-start' }}>
          {items.map((it, i) => {
            const name = it.delay ? delayName[it.kind] : `${kindName[it.kind]} ${it.who}`
            return (
              <li key={`${it.kind}-${it.who}-${i}`} data-sanction-item={it.delay ? `delay-${it.kind}` : it.kind} title={name} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <CardGlyph kind={it.kind} height={cardHeight} title={name} />
                <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', fontSize: `calc(${cardHeight} * 0.82)`, lineHeight: 1, color: 'var(--text)' }}>{it.who}</span>
              </li>
            )
          })}
        </ul>
      )}
      {empty && <span aria-hidden="true" style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1 }}>–</span>}
    </div>
  )
}

const teamStateChip = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '2px 7px',
  borderRadius: 4,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  color: 'var(--text)',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1.3,
  whiteSpace: 'nowrap'
}

/**
 * The card for a stored sanction type: warning / penalty / expulsion /
 * disqualification, a delay warning or penalty (the yellow or red card with
 * "D", the scoresheet's delay mark), an improper request (no card), or null
 * for an unknown type.
 * @param {string} type event payload type
 * @returns {null|{ kind: 'warning'|'penalty'|'expulsion'|'disqualification'|null, delay?: boolean, improperRequest?: boolean }}
 */
export function cardOfSanctionType(type) {
  const s = String(type || '').toLowerCase()
  if (SANCTION_RANK[s]) return { kind: s }
  if (s === 'delay_warning') return { kind: 'warning', delay: true }
  if (s === 'delay_penalty') return { kind: 'penalty', delay: true }
  if (s === 'improper_request') return { kind: null, improperRequest: true }
  return null
}
