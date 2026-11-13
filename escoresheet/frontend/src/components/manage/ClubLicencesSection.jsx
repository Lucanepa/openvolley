import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileUp, Trash2 } from 'lucide-react'
import { clubApi } from '../../lib/accountApi'
import { normalizeName } from '../../domain/savedTeams'
import { usePanelData, useOnline, PanelHead, InlineError, useErrorText } from './common'
import { Button, Chip, EmptyInset, Field, Notice, Row, RowList, RowTool, SearchInput, Select, SkeletonRows, confirmDialog, dayLabel, toast } from '../../ui'

export const LICENCE_LISTS = ['players', 'scorers', 'coaches']
// lib/licences.js MAX_LICENCE_PEOPLE
export const MAX_LICENCE_PEOPLE = 2000
const PAGE = 100
const fold = (v) => normalizeName(v).normalize('NFD').replace(/\p{Diacritic}/gu, '')

/**
 * My club → Licences (db/024, docs/club-licences-spec.md): the club's lists
 * from VolleyManager's club administration (players, scorers, coaches). The
 * club manager picks the list and the exported .xlsx file; the file is read
 * here, in the browser (utils/vmLicenceExport.js), and only the licence
 * number, last name, first name, date of birth and gender of each person
 * are sent. Each upload replaces that list. Below, everyone of the lists
 * once, with the club's teams whose players include them.
 */
export default function ClubLicencesSection({ club, onOpenPerson = null }) {
  const { t } = useTranslation()
  const online = useOnline()
  const errorText = useErrorText()
  const { data, error, loading, reload } = usePanelData(() => clubApi.licences(club.id), [club.id], { enabled: online })
  const lists = data?.lists || {}
  const people = data?.people || []
  const fileInput = useRef(null)
  const [list, setList] = useState('players')
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState(null) // { list, fileName, people, rows, skipped }
  // after a save: the export file still lies on this device, with everyone's contact data
  const [savedFile, setSavedFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [q, setQ] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [genderFilter, setGenderFilter] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const readFile = async (file) => {
    if (!file || reading) return
    setReading(true)
    setUploadError('')
    setPreview(null)
    setSavedFile(null)
    try {
      const { readLicenceExport } = await import('../../utils/vmLicenceExport')
      const r = await readLicenceExport(file)
      if (!r.people.length) setUploadError(t('manage.licences.empty'))
      else if (r.people.length > MAX_LICENCE_PEOPLE) setUploadError(t('manage.licences.tooMany', { max: MAX_LICENCE_PEOPLE }))
      else setPreview({ list, fileName: file.name || '', people: r.people, rows: r.rows, skipped: r.skipped })
    } catch (err) {
      const missing = Array.isArray(err?.missing) ? err.missing.map((f) => t(`manage.licences.fields.${f}`)).join(', ') : ''
      setUploadError(err?.code === 'OV_LICENCE_NO_HEADER'
        ? t('manage.licences.noColumns', { missing })
        : err?.code === 'OV_LICENCE_TOO_BIG' ? t('manage.licences.tooBig') : t('manage.licences.notXlsx'))
    } finally {
      setReading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const save = async () => {
    if (!preview || busy) return
    setBusy(true)
    setUploadError('')
    const res = await clubApi.putLicences(club.id, preview.list, preview.people)
    setBusy(false)
    if (res.error) {
      setUploadError(res.error.code === 'OV_INVALID_REQUEST' && res.error.details ? `${t('manage.errors.generic')} (${res.error.details})` : errorText(res.error))
      return
    }
    toast.success(t('manage.licences.saved', { count: res.data?.count ?? preview.people.length, list: t(`manage.licences.lists.${preview.list}`) }))
    setSavedFile(preview.fileName || 'xlsx')
    setPreview(null)
    reload({ quiet: true })
  }

  const clearList = async (l) => {
    const ok = await confirmDialog({
      title: t('manage.licences.deleteTitle', { list: t(`manage.licences.lists.${l}`) }),
      message: t('manage.licences.deleteBody'),
      confirmLabel: t('manage.licences.delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'danger'
    })
    if (!ok) return
    const res = await clubApi.putLicences(club.id, l, [])
    if (res.error) {
      setUploadError(errorText(res.error))
      return
    }
    toast.success(t('manage.licences.deleted'))
    reload({ quiet: true })
  }

  const shown = useMemo(() => {
    const needle = fold(q)
    return people.filter((p) => (!listFilter || p.lists.includes(listFilter))
      && (!genderFilter || (genderFilter === 'none' ? !p.gender : p.gender === genderFilter))
      && (!needle || fold(`${p.last_name} ${p.first_name || ''} ${p.first_name || ''} ${p.last_name} ${p.sv_number}`).includes(needle)))
  }, [people, q, listFilter, genderFilter])
  const genderLabel = (g) => (g === 'f' ? t('manage.licences.woman') : g === 'm' ? t('manage.licences.man') : null)

  return (
    <section data-testid="club-licences">
      <PanelHead title={t('manage.licences.title')} level={2} />
      <p className="mb-3 text-sm text-stone-500">{t('manage.licences.hint')}</p>
      {error && <Notice className="mb-3">{errorText(error)}</Notice>}

      {/* the upload: which list, then the file */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={t('manage.licences.list')} className="sm:w-56">
          <Select value={list} onChange={(e) => { setList(e.target.value); setPreview(null); setUploadError('') }} data-testid="licences-list">
            {LICENCE_LISTS.map((l) => <option key={l} value={l}>{t(`manage.licences.lists.${l}`)}</option>)}
          </Select>
        </Field>
        <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(e) => readFile(e.target.files?.[0])} data-testid="licences-file" />
        <Button variant="secondary" icon={FileUp} loading={reading} disabled={!online || reading || busy} onClick={() => fileInput.current?.click()} data-testid="licences-choose">
          {t('manage.licences.choose')}
        </Button>
      </div>
      <InlineError error={uploadError} className="mb-3" />
      {savedFile && !preview && (
        <div className="mb-3" data-testid="licences-delete-file">
          <Notice tone="warning">{t('manage.licences.deleteFile', { file: savedFile })}</Notice>
        </div>
      )}
      {preview && (
        <div className="mb-4 space-y-3 rounded-xl border border-stone-200 bg-stone-50/60 p-3" data-testid="licences-preview">
          <p className="m-0 text-sm font-medium text-stone-900">{t('manage.licences.previewCount', { count: preview.people.length })}</p>
          <p className="m-0 text-xs text-stone-600">{t('manage.licences.previewList', { list: t(`manage.licences.lists.${preview.list}`) })}</p>
          {preview.skipped > 0 && <p className="m-0 text-xs text-amber-800">{t('manage.licences.previewSkipped', { count: preview.skipped })}</p>}
          {(lists[preview.list]?.count || 0) > 0 && (
            <p className="m-0 text-xs text-stone-600">{t('manage.licences.previewReplaces', { count: lists[preview.list].count })}</p>
          )}
          <ul className="m-0 list-none space-y-0.5 p-0 text-xs text-stone-700">
            {preview.people.slice(0, 5).map((p) => (
              <li key={p.sv_number} className="[overflow-wrap:anywhere]">{p.last_name} {p.first_name || ''} · {p.sv_number}{p.dob ? ` · ${dayLabel(p.dob, { year: true })}` : ''}{p.gender ? ` · ${genderLabel(p.gender)}` : ''}</li>
            ))}
            {preview.people.length > 5 && <li>…</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button variant="positive" onClick={save} loading={busy} disabled={!online || busy} data-testid="licences-save">{t('manage.licences.save')}</Button>
            <Button variant="secondary" onClick={() => setPreview(null)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
          </div>
        </div>
      )}

      {/* the three lists: how many, when, by whom */}
      {loading && !data ? <SkeletonRows rows={3} pill={false} /> : data && (
        <RowList data-testid="licences-lists">
          {LICENCE_LISTS.map((l) => {
            const s = lists[l] || { count: 0 }
            return (
              <Row
                key={l}
                stripe={false}
                toolsIndent="sm:pl-2"
                actionIndent="pl-1.5"
                title={t(`manage.licences.lists.${l}`)}
                meta={s.count > 0
                  ? <>
                      <span>{t('manage.licences.people', { count: s.count })}</span>
                      {s.manual > 0 && <span>{t('manage.licences.manualCount', { count: s.manual })}</span>}
                      {s.imported_at && <span>{t('manage.licences.updated', { when: dayLabel(s.imported_at, { year: true }), name: s.imported_by_name || '–' })}</span>}
                    </>
                  : <span>{t('manage.licences.notUploaded')}</span>}
                tools={s.count > 0 ? (
                  <RowTool disabled={!online} onClick={() => clearList(l)} data-testid="licences-delete">
                    <Trash2 size={14} aria-hidden className="mr-1 inline" />{t('manage.licences.delete')}
                  </RowTool>
                ) : null}
              />
            )
          })}
        </RowList>
      )}

      {/* everyone of the lists once */}
      {data && people.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <SearchInput size="md" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} placeholder={t('manage.licences.search')} aria-label={t('manage.licences.search')} data-testid="licences-search" />
            <Select value={listFilter} onChange={(e) => { setListFilter(e.target.value); setLimit(PAGE) }} aria-label={t('manage.licences.list')} className="sm:w-44" data-testid="licences-filter-list">
              <option value="">{t('manage.licences.allLists')}</option>
              {LICENCE_LISTS.map((l) => <option key={l} value={l}>{t(`manage.licences.lists.${l}`)}</option>)}
            </Select>
            <Select value={genderFilter} onChange={(e) => { setGenderFilter(e.target.value); setLimit(PAGE) }} aria-label={t('manage.licences.gender')} className="sm:w-40" data-testid="licences-filter-gender">
              <option value="">{t('manage.licences.allGenders')}</option>
              <option value="f">{t('manage.licences.women')}</option>
              <option value="m">{t('manage.licences.men')}</option>
              <option value="none">{t('manage.licences.noGender')}</option>
            </Select>
          </div>
          <p className="m-0 text-xs text-stone-500">{t('manage.licences.shown', { count: shown.length, total: people.length })}</p>
          {shown.length === 0 ? (
            <EmptyInset>{t('manage.licences.noMatch')}</EmptyInset>
          ) : (
            <RowList data-testid="licences-people">
              {shown.slice(0, limit).map((p) => (
                <Row
                  key={p.sv_number}
                  stripe={false}
                  onOpen={onOpenPerson && p.id ? () => onOpenPerson(p.id) : undefined}
                  label={`${p.last_name} ${p.first_name || ''}`.trim()}
                  data-testid="licence-person"
                  title={`${p.last_name} ${p.first_name || ''}`.trim()}
                  meta={<>
                    <span className="tabular-nums">{t('clubPlayers.licence', { number: p.sv_number })}</span>
                    {p.dob && <span>{dayLabel(p.dob, { year: true })}</span>}
                    {p.gender && <span>{genderLabel(p.gender)}</span>}
                  </>}
                  chips={<>
                    {p.lists.map((l) => <Chip key={l} tone={l === 'players' ? 'indigo' : l === 'coaches' ? 'emerald' : 'sky'}>{t(`manage.licences.lists.${l}`)}</Chip>)}
                    {p.manual && <Chip tone="amber">{t('manage.licences.manual')}</Chip>}
                    {p.teams.map((team) => <Chip key={team.id}>{team.name}</Chip>)}
                  </>}
                />
              ))}
            </RowList>
          )}
          {shown.length > limit && (
            <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE)} data-testid="licences-more">{t('manage.licences.showMore', { count: Math.min(PAGE, shown.length - limit) })}</Button>
          )}
        </div>
      )}
    </section>
  )
}
