import { useTranslation } from 'react-i18next'
import { CloudOff } from 'lucide-react'
import { openRestore } from '../utils/manageNav'
import { cn, FOCUS_RING } from '../ui'

/**
 * The text of a match's cloud block (set by the sync queue when the server
 * refused the match for good, spec 6.7).
 * @returns {{key: string, params: object, join: boolean}|null}
 */
export function cloudBlockMessage(block, match, t) {
  if (!block?.code) return null
  const claim = block.claim || null
  const game = claim?.game_n ?? match?.gameN ?? match?.game_n ?? match?.matchInfo?.gameN ?? ''
  switch (block.code) {
    case 'OV_SCORER_REQUIRED':
      return { key: 'cloudBlock.scorerRequired', params: {}, join: false }
    case 'OV_MATCH_CLOSED':
      return { key: 'cloudBlock.matchClosed', params: {}, join: false }
    case 'OV_GAME_TAKEN':
      if (claim?.mine) return { key: 'cloudBlock.gameTakenMine', params: { game }, join: true }
      if (claim) {
        return {
          key: 'cloudBlock.gameTaken',
          params: {
            game,
            name: claim.scorer_name || t('manage.games.unknownScorer'),
            status: claim.status ? t(`manage.status.${claim.status}`, claim.status) : '–'
          },
          join: true
        }
      }
      return { key: 'cloudBlock.gameTakenUnknown', params: {}, join: true }
    default:
      return null
  }
}

/** Amber notice "Not synced: …" for a match the server refused. */
export default function CloudBlockNotice({ match, className = '' }) {
  const { t } = useTranslation()
  const msg = cloudBlockMessage(match?.cloudBlock, match, t)
  if (!msg) return null
  const gameN = match?.cloudBlock?.claim?.game_n ?? match?.gameN ?? match?.game_n ?? null
  return (
    <div className={cn('ov-kit', className)}>
      <div role="status" data-testid="cloud-block-notice" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        <CloudOff size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="flex-1">{t(msg.key, msg.params)}</span>
        {msg.join && (
          <button
            type="button"
            onClick={() => openRestore({ gameN })}
            className={cn('shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-semibold text-amber-800 hover:bg-amber-100', FOCUS_RING)}
          >
            {t('cloudBlock.joinWithPin')}
          </button>
        )}
      </div>
    </div>
  )
}
