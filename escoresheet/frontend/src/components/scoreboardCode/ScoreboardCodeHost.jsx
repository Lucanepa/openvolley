import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../Modal'
import { db } from '../../db/db'
import { scoreboardCodes } from '../../utils/scoreboardCode'
import ScoreboardCodePanel from './ScoreboardCodePanel'
import { closeScoreboardCode, useScoreboardCodePanel } from './scoreboardCodeStore'

const MATCH_CHECK_MS = 30000
// closed for good: approved, final (a match at its end screen, 'ended', keeps its boards)
const CLOSED_STATUSES = ['approved', 'final']

/**
 * "Show on a scoreboard", mounted once beside the app (main.jsx): the panel,
 * and the end of every stored code whose match is closed or no longer on
 * this device (the relay is told, its boards stop).
 */
export default function ScoreboardCodeHost({ codes = scoreboardCodes, matches = () => db.matches }) {
  const { t } = useTranslation()
  const panel = useScoreboardCodePanel()

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        for (const row of await codes.stored()) {
          if (cancelled) return
          const m = await matches().get(row.matchId)
          if (!m || CLOSED_STATUSES.includes(m.status)) await codes.stop({ matchId: row.matchId, relayKey: row.relayKey })
        }
      } catch { /* no database (tests) */ }
    }
    check()
    const timer = setInterval(check, MATCH_CHECK_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [codes, matches])

  if (!panel) return null
  return (
    <Modal title={t('scoreboardCode.title')} open={true} onClose={closeScoreboardCode} width={620} zIndex={1100}>
      <ScoreboardCodePanel match={panel} onClose={closeScoreboardCode} codes={codes} />
    </Modal>
  )
}
