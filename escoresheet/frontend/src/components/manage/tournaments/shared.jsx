import { useTranslation } from 'react-i18next'
import { tournamentErrorKey } from '../../../lib/tournamentApi'
import { parseSource } from '../../../domain/beachTournament'
import { StatusPill } from '../../../ui'

export const STATUS_TONE = { draft: 'neutral', published: 'planned', live: 'brand', finished: 'done', archived: 'neutral' }

/** '11.07.2026', '11.–12.07.2026' or '31.07.2026 – 01.08.2026' (dates as stored, YYYY-MM-DD). */
export function datesLabel(from, to) {
  const d = (s) => (s ? s.split('-').reverse().join('.') : '')
  if (!from) return ''
  if (!to || to === from) return d(from)
  if (from.slice(0, 7) === to.slice(0, 7)) return `${from.slice(8, 10)}.–${d(to)}`
  return `${d(from)} – ${d(to)}`
}

/** A tournament's status as a round pill with its word. */
export function TournamentStatus({ status }) {
  const { t } = useTranslation()
  return <StatusPill tone={STATUS_TONE[status] || 'neutral'}>{t(`tournaments.statuses.${status}`, status)}</StatusPill>
}

/** The text of a tournament API error. */
export function useTournamentError() {
  const { t } = useTranslation()
  return (error) => (error ? t(tournamentErrorKey(error)) : '')
}

/** 'A1 · Women' */
export function useDrawName() {
  const { t } = useTranslation()
  return (d) => (d ? `${d.category} · ${t(`tournaments.genders.${d.gender}`)}` : '')
}

/** The label of one side of a match: the pair, else where it comes from (Seed 4, Winner W3). */
export function useSideLabel(entriesById) {
  const { t } = useTranslation()
  return (entryId, source) => {
    if (entryId && entriesById.get(entryId)) return entriesById.get(entryId).name
    const s = parseSource(source)
    if (!s) return t('tournaments.tbd')
    return s.kind === 'seed' ? t('tournaments.sources.seed', { n: s.value }) : t(`tournaments.sources.${s.kind}`, { code: s.value })
  }
}
