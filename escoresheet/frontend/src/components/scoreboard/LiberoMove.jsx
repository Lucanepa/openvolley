import { useTranslation } from 'react-i18next'

// The libero dialogs' title and their two boxes (owner 2026-11-25, tester
// feedback): what happens is the title, big ("Libero IN", "Libero OUT",
// "Libero IN?"), no sentence under it; then the player coming IN (green, ↑)
// and the one going OUT (red, ↓), the arrows of the scoreboard's substitution
// boxes, IN first as in the substitution dialog. The rotation notice, the
// libero confirm and the re-entry question all draw them so.

const BOX = {
  in: { background: '#dcfce7', border: '2px solid #22c55e', ink: '#166534', tag: '#22c55e', arrow: '↑' },
  out: { background: '#fef2f2', border: '2px solid #ef4444', ink: '#991b1b', tag: '#ef4444', arrow: '↓' }
}

/** The dialog's title: what happens, in a few big words. */
export function LiberoMoveTitle({ children, testId = 'libero-move-title' }) {
  return (
    <div
      data-testid={testId}
      style={{ fontSize: '22px', fontWeight: 800, textAlign: 'center', color: '#111827', margin: '0 0 14px', letterSpacing: '0.01em' }}
    >
      {children}
    </div>
  )
}

function MoveBox({ kind, number, tag }) {
  const { t } = useTranslation()
  const s = BOX[kind]
  const label = kind === 'in' ? t('scoreboard.liberoMove.in', 'IN') : t('scoreboard.liberoMove.out', 'OUT')
  return (
    <div
      data-testid={`libero-move-${kind}`}
      aria-label={`${label} #${number ?? '?'}${tag ? ` ${tag}` : ''}`}
      style={{ flex: 1, minWidth: 0, padding: '12px 10px', background: s.background, borderRadius: '12px', border: s.border, textAlign: 'center' }}
    >
      <div aria-hidden="true" style={{ fontSize: '12px', color: s.ink, fontWeight: 700, marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        {label}
      </div>
      <div aria-hidden="true" style={{ fontSize: '28px', fontWeight: 800, color: s.ink, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ fontSize: '26px' }}>{s.arrow}</span>
        <span>#{number ?? '?'}</span>
      </div>
      {tag && (
        <div aria-hidden="true" style={{ fontSize: '12px', padding: '2px 8px', background: s.tag, color: '#fff', borderRadius: '4px', display: 'inline-block', marginTop: '4px', fontWeight: 700 }}>
          {tag}
        </div>
      )}
    </div>
  )
}

/**
 * IN (green, ↑) then OUT (red, ↓).
 * @param {{ inNumber: number|string, inTag?: string, outNumber: number|string, outTag?: string }} props
 *   a tag is the libero's L1 / L2 / LR, on the box of the libero
 */
export function LiberoMoveBoxes({ inNumber, inTag, outNumber, outTag }) {
  return (
    <div style={{ display: 'flex', gap: '12px', marginBottom: '20px' }}>
      <MoveBox kind="in" number={inNumber} tag={inTag} />
      <MoveBox kind="out" number={outNumber} tag={outTag} />
    </div>
  )
}
