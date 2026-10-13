import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clubsApi } from '../../lib/accountApi'
import KitModal from './KitModal'
import { usePanelData, useOnline, OfflineBanner, PanelHead, InlineError, useErrorText } from './common'
import { Button, Checkbox, Chip, EmptyInset, Field, Input, Notice, Row, RowList, RowTool, SearchInput, SkeletonRows, Switch, confirmDialog, toast } from '../../ui'

/**
 * Clubs (admins, OpenVolley; db/018, lib/clubs.js): a scorer scores the home
 * games of its own club(s). A club is a name and the VolleyManager team names
 * that play for it; accounts get their clubs in Accounts or through an invite
 * code. The rule is off until it is switched on here: then every scorer
 * without a club is blocked from official games, so set the clubs up first.
 */
export default function ClubsPanel() {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubsApi.list(), [], { enabled: online })
  const clubs = data?.clubs || []
  const ruleOn = data?.rule?.enabled === true
  const [editing, setEditing] = useState(null) // a club, or {} for a new one
  const [ruleBusy, setRuleBusy] = useState(false)

  const setRule = async (enabled) => {
    if (enabled) {
      const ok = await confirmDialog({
        title: t('manage.clubs.ruleOnTitle'),
        message: t('manage.clubs.ruleOnBody'),
        confirmLabel: t('manage.clubs.ruleOnConfirm'),
        tone: 'danger'
      })
      if (!ok) return
    }
    setRuleBusy(true)
    const res = await clubsApi.setRule(enabled)
    setRuleBusy(false)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    toast.success(enabled ? t('manage.clubs.ruleIsOn') : t('manage.clubs.ruleIsOff'))
    reload()
  }

  const remove = async (club) => {
    const ok = await confirmDialog({
      title: t('manage.clubs.deleteTitle', { name: club.name }),
      message: t('manage.clubs.deleteBody', { count: club.scorers }),
      confirmLabel: t('manage.clubs.delete'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await clubsApi.remove(club.id)
    if (res.error) {
      toast.error(errorText(res.error))
      return
    }
    toast.success(t('manage.clubs.deleted'))
    reload()
  }

  return (
    <section data-testid="manage-clubs">
      <PanelHead title={t('manage.tabs.clubs')}>
        <Button variant="positive" size="md" disabled={!online} onClick={() => setEditing({})} data-testid="new-club">{t('manage.clubs.new')}</Button>
      </PanelHead>
      <OfflineBanner online={online} />
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-stone-200 bg-white px-3 py-3">
        <Switch
          checked={ruleOn}
          onCheckedChange={setRule}
          disabled={!online || ruleBusy || !data}
          aria-labelledby="club-rule-title"
          data-testid="club-rule-switch"
        />
        <div className="min-w-0">
          <p id="club-rule-title" className="text-sm font-semibold text-stone-900">{t('manage.clubs.ruleTitle')}</p>
          <p className="mt-0.5 text-xs text-stone-600">{ruleOn ? t('manage.clubs.ruleOnHint') : t('manage.clubs.ruleOffHint')}</p>
        </div>
      </div>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}
      {loading && !data ? (
        <SkeletonRows rows={4} pill={false} />
      ) : clubs.length === 0 ? (
        <EmptyInset>{t('manage.clubs.empty')}</EmptyInset>
      ) : (
        <RowList>
          {clubs.map((c) => (
            <Row
              key={c.id}
              stripe={false}
              toolsIndent="sm:pl-2"
              actionIndent="pl-1.5"
              title={c.name}
              meta={<span>{t('manage.clubs.scorers', { count: c.scorers })}</span>}
              chips={c.teams.length
                ? c.teams.map((name) => <Chip key={name}>{name}</Chip>)
                : <Chip tone="amber">{t('manage.clubs.noTeams')}</Chip>}
              tools={<>
                <RowTool disabled={!online} onClick={() => setEditing(c)}>{t('manage.clubs.edit')}</RowTool>
                <RowTool disabled={!online} onClick={() => remove(c)}>{t('manage.clubs.delete')}</RowTool>
              </>}
            />
          ))}
        </RowList>
      )}
      {editing && (
        <ClubModal
          club={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload() }}
        />
      )}
    </section>
  )
}

/** A club's name and its VolleyManager teams (a team plays for one club). */
function ClubModal({ club, onClose, onSaved }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [name, setName] = useState(club?.name || '')
  const [teams, setTeams] = useState(() => new Set(club?.teams || []))
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const found = usePanelData(() => clubsApi.vmTeams({ q: term || undefined }), [term])
  // a short pause after typing before the server is asked
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 250)
    return () => clearTimeout(id)
  }, [q])
  const options = useMemo(() => {
    const list = found.data?.teams || []
    // the club's own teams stay on top, even when the search hides them
    const names = new Set(list.map((x) => x.name))
    const own = [...teams].filter((n) => !names.has(n)).map((n) => ({ name: n, club_id: club?.id ?? null }))
    return [...own, ...list]
  }, [found.data, teams, club])

  const toggle = (n) => {
    const next = new Set(teams)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    setTeams(next)
    setError('')
  }
  const valid = name.trim().length >= 1
  const save = async () => {
    if (!valid || busy) return
    setBusy(true)
    const body = { name: name.trim(), teams: [...teams] }
    const res = club ? await clubsApi.update(club.id, body) : await clubsApi.create(body)
    setBusy(false)
    if (res.error) {
      setError(res.error.code === 'OV_TEAM_TAKEN'
        ? t('manage.clubs.teamTaken', { teams: res.error.details || '' })
        : res.error.code === 'OV_CLUB_EXISTS' ? t('manage.clubs.nameTaken') : errorText(res.error))
      return
    }
    toast.success(t('manage.clubs.saved'))
    onSaved()
  }
  return (
    <KitModal
      open
      onClose={() => { if (!busy) onClose() }}
      decision
      layout="sections"
      title={club ? t('manage.clubs.editTitle', { name: club.name }) : t('manage.clubs.new')}
      closeLabel={t('common.close', 'Close')}
      footer={<>
        <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
        <Button variant="positive" size="lg" onClick={save} loading={busy} disabled={!valid || busy} data-testid="save-club">{t('manage.clubs.save')}</Button>
      </>}
    >
      <div className="space-y-3">
        <Field label={t('manage.clubs.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required autoFocus />
        </Field>
        <Field label={t('manage.clubs.teams')} hint={t('manage.clubs.teamsHint')}>
          <SearchInput size="md" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('manage.clubs.searchTeams')} aria-label={t('manage.clubs.searchTeams')} maxLength={80} />
        </Field>
        <p className="text-xs text-stone-600" data-testid="club-team-count">{t('manage.clubs.picked', { count: teams.size })}</p>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-stone-200 bg-white p-2" data-testid="club-team-options">
          {found.loading && !found.data ? (
            <SkeletonRows rows={3} pill={false} />
          ) : options.length === 0 ? (
            <p className="px-1 py-2 text-xs text-stone-500">{t('manage.clubs.noVmTeams')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {options.map((o) => {
                const elsewhere = o.club_id && o.club_id !== club?.id ? o.club_name : null
                return (
                  <Checkbox
                    key={o.name}
                    label={elsewhere ? `${o.name} · ${t('manage.clubs.inClub', { club: elsewhere })}` : o.name}
                    checked={teams.has(o.name)}
                    disabled={!!elsewhere && !teams.has(o.name)}
                    onChange={() => toggle(o.name)}
                  />
                )
              })}
            </div>
          )}
        </div>
        <InlineError error={error} />
      </div>
    </KitModal>
  )
}
