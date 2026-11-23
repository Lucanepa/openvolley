import { useTranslation } from 'react-i18next'

/**
 * A team's substitutions of the set, as recorded: number, score, position, out
 * and in, the exceptional ones marked. The SUB box's list (the details
 * dialog while a rally is in play, the substitution dialog's "Recorded" view).
 * A VIEW only (Scoreboard getSubstitutionDetails).
 * @param {{ details: Array<{index:number, score:string, position:string, playerOut:any, playerIn:any, exceptional?:boolean}>|null }} props
 */
export default function SubstitutionList({ details }) {
  const { t } = useTranslation()
  if (!details || details.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>
        {t('scoreboard.dialogs.noSubstitutionsYet', 'No substitutions taken yet')}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {details.map((detail, index) => (
        <div
          key={index}
          data-sub-recorded={detail.index}
          style={{
            padding: '12px',
            background: 'var(--panel-2)',
            borderRadius: '8px',
            border: '1px solid var(--border)'
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <div style={{ fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
              {t('scoreboard.dialogs.substitutionN', { defaultValue: 'Substitution {{n}}', n: detail.index })}
              {detail.exceptional && (
                <span data-sub-exceptional="" style={{ fontSize: '12px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: '#fef3c7', color: '#78350f', border: '1px solid #fcd34d' }}>
                  {t('corrections.chip.exceptional', 'Exceptional')}
                </span>
              )}
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
              {detail.score}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '16px', fontSize: '14px', color: 'var(--muted)' }}>
            <div>
              <span style={{ fontWeight: 600 }}>{t('scoreboard.dialogs.positionLabel', 'Position:')}</span> {detail.position}
            </div>
            <div>
              <span style={{ fontWeight: 600 }}>{t('scoreboard.dialogs.outLabel', 'Out:')}</span> {detail.playerOut}
            </div>
            <div>
              <span style={{ fontWeight: 600 }}>{t('scoreboard.dialogs.inLabel', 'In:')}</span> {detail.playerIn}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
