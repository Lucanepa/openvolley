import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UserPlus } from 'lucide-react'
import KitModal from './manage/KitModal'
import { normalizeName } from '../domain/savedTeams'
import { Button, Checkbox, Chip, EmptyInset, Notice, SearchInput, dayLabel } from '../ui'

const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')

/**
 * "Add from club" (db/024, docs/club-licences-spec.md): pick players of the
 * club's licence list, by name or licence number, several at once. `players`
 * are the people offered (the caller leaves out the other gender);
 * `hiddenCount` of the others are not offered because of `gender`.
 * `isTaken(person)` marks one already in the roster. onPick(people) gets the
 * chosen ones in the list's shape { sv_number, last_name, first_name, dob, gender }.
 * Used by the manager's My teams and by Match Setup (an offline copy there).
 */
export default function ClubPlayerPickerModal({ open, onClose, onPick, players = [], gender = null, hiddenCount = 0, title, isTaken = () => false, zIndex }) {
  if (!open) return null
  return <PickerBody {...{ onClose, onPick, players, gender, hiddenCount, title, isTaken, zIndex }} />
}

function PickerBody({ onClose, onPick, players, gender, hiddenCount, title, isTaken, zIndex }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [chosen, setChosen] = useState(() => new Set())
  const list = useMemo(() => {
    const needle = fold(q)
    return players.filter((p) => !needle || fold(`${p.last_name} ${p.first_name || ''} ${p.first_name || ''} ${p.last_name} ${p.sv_number}`).includes(needle))
  }, [players, q])
  const toggle = (sv, on) => setChosen((cur) => {
    const next = new Set(cur)
    if (on) next.add(sv)
    else next.delete(sv)
    return next
  })
  const pick = () => {
    const out = players.filter((p) => chosen.has(p.sv_number))
    if (out.length) onPick(out)
  }
  return (
    <KitModal
      open
      zIndex={zIndex}
      onClose={onClose}
      size="lg"
      icon={UserPlus}
      title={title || t('clubPlayers.title')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" disabled={chosen.size === 0} onClick={pick} data-testid="club-picker-add">
          {t('clubPlayers.addCount', { count: chosen.size })}
        </Button>
      </>}
    >
      <div className="space-y-3" data-testid="club-picker">
        {(gender === 'm' || gender === 'f') && (
          <Notice>{t(gender === 'f' ? 'clubPlayers.onlyWomen' : 'clubPlayers.onlyMen', { count: hiddenCount })}</Notice>
        )}
        {players.length === 0 ? (
          <EmptyInset>{t('clubPlayers.none')}</EmptyInset>
        ) : (
          <>
            <SearchInput size="md" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('clubPlayers.search')} aria-label={t('clubPlayers.search')} data-testid="club-picker-search" />
            {list.length === 0 ? (
              <EmptyInset>{t('clubPlayers.noMatch')}</EmptyInset>
            ) : (
              <ul className="divide-y divide-stone-200/70 overflow-hidden rounded-xl border border-stone-200/70 bg-white">
                {list.map((p) => {
                  const taken = isTaken(p)
                  const meta = [p.dob ? dayLabel(p.dob, { year: true }) : null, t('clubPlayers.licence', { number: p.sv_number })].filter(Boolean).join(' · ')
                  return (
                    <li key={p.sv_number} className="flex items-center gap-2 px-3 py-2" data-testid="club-picker-row">
                      <Checkbox
                        checked={taken || chosen.has(p.sv_number)}
                        disabled={taken}
                        onChange={(e) => toggle(p.sv_number, e.target.checked)}
                        label={<span className="font-medium text-stone-900 [overflow-wrap:anywhere]">{p.last_name} {p.first_name || ''}</span>}
                        hint={meta}
                        className="min-w-0 flex-1"
                      />
                      {taken && <Chip>{t('clubPlayers.inRoster')}</Chip>}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </KitModal>
  )
}
