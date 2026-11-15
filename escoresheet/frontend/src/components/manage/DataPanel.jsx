import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Database, Lock, Plus, Trash2 } from 'lucide-react'
import { admin } from '../../lib/accountApi'
import { OfflineBanner, PageMissing, PanelHead, useErrorText, useOnline, usePanelData, usePanelRoute } from './common'
import { BackButton, Banner, Button, Checkbox, Chip, EmptyInset, Field, FormError, Input, Notice, Row, RowList, SearchInput, Select, SkeletonRows, Textarea, confirmDialog, toast } from '../../ui'

/*
 * The Data tab (super admins, lib/dataAdmin.js): every table of the database's
 * public schema, read and changed one row at a time. Pages:
 *   #data                       the tables
 *   #data/<table>               its rows (search, one filter, sort, pages)
 *   #data/<table>/row/<key>     one row (the key as JSON), edited in place
 *   #data/<table>/new           a new row
 * The server decides everything (secret columns, read-only tables, the
 * closed-match lock) and audits every write; this page only draws it.
 */

const PAGE = 50
const OPS = ['like', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'null', 'notnull']
const NO_VALUE_OPS = new Set(['null', 'notnull'])

/** A list cell's text: a cut value ends in "…", json as JSON, null as an em dash. */
export function cellText(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object' && v.$cut !== undefined) return `${v.$cut}…`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** The text an editor starts with for a stored value of this column. */
export function editText(col, v) {
  if (v === null || v === undefined) return ''
  if (col.kind === 'json' || col.kind === 'array' || typeof v === 'object') return JSON.stringify(v, null, 2)
  return String(v)
}

/**
 * The value an edited field sends: { value } or { error } (json that does not
 * parse). Numbers and the rest go as typed: the database types them by the column.
 */
export function parseField(col, { text, isNull }) {
  if (isNull) return { value: null }
  if (col.kind === 'json' || col.kind === 'array') {
    try {
      const value = JSON.parse(text)
      if (col.kind === 'array' && !Array.isArray(value)) return { error: 'array' }
      return { value }
    } catch {
      return { error: 'json' }
    }
  }
  if (col.kind === 'bool') return { value: text === 'true' }
  return { value: text }
}

export const keyOfRow = (table, row) => Object.fromEntries(table.pk.map((k) => [k, row[k]]))

function errorLine(error, errorText) {
  if (!error) return ''
  // the database's own words (a constraint, a type) are the most useful here
  if (/^OV_DATA_|^OV_MATCH_/.test(error.code || '') && error.message) return error.message
  return errorText(error)
}

/** The Data tab: its pages by the route (see the header). */
export default function DataPanel({ route, onRoute }) {
  const { t } = useTranslation()
  const online = useOnline()
  const [segments, go] = usePanelRoute(route, onRoute)
  const tables = usePanelData(() => admin.dataTables(), [])
  const byName = useMemo(() => new Map((tables.data?.tables || []).map((x) => [x.name, x])), [tables.data])
  const [name, page, rawKey] = segments
  const table = name ? byName.get(name) : null

  let body
  if (!name) {
    body = <TableList tables={tables} onOpen={(n) => go([n])} />
  } else if (!table) {
    body = <PageMissing loading={tables.loading} error={tables.error} onBack={() => go([])} backLabel={t('manage.data.allTables')} />
  } else if (page === 'new') {
    body = <RowPage key={`${name}/new`} table={table} rowKey={null} onBack={() => go([name])} onSaved={(row) => go([name, 'row', JSON.stringify(keyOfRow(table, row))], { push: false })} />
  } else if (page === 'row' && rawKey) {
    let key = null
    try { key = JSON.parse(rawKey) } catch { /* a broken link: PageMissing */ }
    body = key
      ? <RowPage key={`${name}/${rawKey}`} table={table} rowKey={key} onBack={() => go([name])} onDeleted={() => go([name], { push: false })} />
      : <PageMissing onBack={() => go([name])} backLabel={name} />
  } else {
    body = <RowsPage table={table} onBack={() => go([])} onOpenRow={(row) => go([name, 'row', JSON.stringify(keyOfRow(table, row))])} onNew={() => go([name, 'new'])} />
  }
  return (
    <section data-testid="data-panel">
      <OfflineBanner online={online} />
      {body}
    </section>
  )
}

function TableList({ tables, onOpen }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [q, setQ] = useState('')
  const list = (tables.data?.tables || []).filter((x) => !q || x.name.includes(q.trim().toLowerCase()))
  return (
    <>
      <PanelHead title={t('manage.tabs.data')} />
      <Banner tone="info" icon={Database} className="mb-3">{t('manage.data.intro')}</Banner>
      <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('manage.data.findTable')} aria-label={t('manage.data.findTable')} className="mb-3" />
      {tables.error && <Notice className="mb-3">{errorText(tables.error)}</Notice>}
      {tables.loading && !tables.data ? <SkeletonRows rows={8} pill={false} /> : list.length === 0 ? (
        <EmptyInset>{t('manage.data.noTables')}</EmptyInset>
      ) : (
        <RowList>
          {list.map((x) => (
            <Row
              key={x.name}
              stripe={false}
              onOpen={() => onOpen(x.name)}
              label={x.name}
              title={<span className="font-mono">{x.name}</span>}
              meta={<>
                <span>{t('manage.data.rowsAbout', { count: x.estimate })}</span>
                <span>{t('manage.data.columns', { count: x.columns.length })}</span>
              </>}
              chips={x.read_only ? <Chip tone="stone"><Lock size={11} aria-hidden className="mr-1 inline" />{t(`manage.data.readOnly.${x.read_only}`)}</Chip> : null}
            />
          ))}
        </RowList>
      )}
    </>
  )
}

function RowsPage({ table, onBack, onOpenRow, onNew }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const online = useOnline()
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState({ col: '', op: 'like', val: '' })
  const [applied, setApplied] = useState({ col: '', op: 'like', val: '' })
  const [sort, setSort] = useState({ col: '', dir: '' })
  const [offset, setOffset] = useState(0)
  // the search is sent a moment after the last key
  useEffect(() => {
    const id = setTimeout(() => { setSearch(q); setOffset(0) }, 350)
    return () => clearTimeout(id)
  }, [q])
  const params = {
    q: search || undefined,
    ...(applied.col ? { col: applied.col, op: applied.op, val: NO_VALUE_OPS.has(applied.op) ? undefined : applied.val } : {}),
    ...(sort.col ? { sort: sort.col, dir: sort.dir || 'asc' } : {}),
    limit: PAGE,
    offset
  }
  const rows = usePanelData(() => admin.dataRows(table.name, params), [table.name, JSON.stringify(params)])
  const data = rows.data || rows.stale
  const cols = table.columns
  const sortable = (c) => c.kind !== 'json'
  const toggleSort = (c) => {
    if (!sortable(c)) return
    setOffset(0)
    setSort((s) => (s.col !== c.name ? { col: c.name, dir: 'asc' } : s.dir === 'asc' ? { col: c.name, dir: 'desc' } : { col: '', dir: '' }))
  }
  const total = data?.total ?? 0
  const filterCol = cols.find((c) => c.name === filter.col)
  const ops = filterCol?.kind === 'json' ? ['like', 'eq', 'ne', 'null', 'notnull'] : OPS

  return (
    <>
      <BackButton label={t('manage.data.allTables')} onClick={onBack} className="mb-3" />
      <PanelHead title={<span className="font-mono">{table.name}</span>}>
        {table.read_only
          ? <Chip tone="stone"><Lock size={11} aria-hidden className="mr-1 inline" />{t(`manage.data.readOnly.${table.read_only}`)}</Chip>
          : <Button size="sm" icon={Plus} onClick={onNew} disabled={!online}>{t('manage.data.addRow')}</Button>}
      </PanelHead>
      {table.secret_columns.length > 0 && (
        <p className="mb-3 text-xs text-stone-500">{t('manage.data.secretHidden', { columns: table.secret_columns.join(', ') })}</p>
      )}
      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-end">
        <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('manage.data.search')} aria-label={t('manage.data.search')} wrapperClassName="lg:flex-1" />
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(filter) }}
        >
          <Select
            size="sm"
            aria-label={t('manage.data.filterColumn')}
            value={filter.col}
            onChange={(e) => setFilter((f) => ({ ...f, col: e.target.value }))}
            placeholder={t('manage.data.filterColumn')}
            options={cols.map((c) => ({ value: c.name, label: c.name }))}
          />
          <Select
            size="sm"
            aria-label={t('manage.data.filterOp')}
            value={filter.op}
            onChange={(e) => setFilter((f) => ({ ...f, op: e.target.value }))}
            options={ops.map((op) => ({ value: op, label: t(`manage.data.ops.${op}`) }))}
          />
          {!NO_VALUE_OPS.has(filter.op) && (
            <Input size="sm" aria-label={t('manage.data.filterValue')} value={filter.val} onChange={(e) => setFilter((f) => ({ ...f, val: e.target.value }))} className="w-40" />
          )}
          <Button size="sm" variant="secondary" type="submit" disabled={!filter.col}>{t('manage.data.apply')}</Button>
          {applied.col && (
            <Button size="sm" variant="text" type="button" onClick={() => { const none = { col: '', op: 'like', val: '' }; setFilter(none); setApplied(none); setOffset(0) }}>{t('manage.data.clearFilter')}</Button>
          )}
        </form>
      </div>
      {rows.error && <Notice className="mb-3">{errorLine(rows.error, errorText)}</Notice>}
      {!data && rows.loading ? <SkeletonRows rows={8} pill={false} /> : !data?.rows?.length ? (
        <EmptyInset>{t('manage.data.noRows')}</EmptyInset>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
            <table className="min-w-full text-left text-xs" data-testid="data-rows">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-stone-500">
                  {cols.map((c) => (
                    <th key={c.name} scope="col" className="whitespace-nowrap px-2 py-2 font-semibold">
                      {sortable(c) ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-stone-800" onClick={() => toggleSort(c)} aria-label={t('manage.data.sortBy', { column: c.name })}>
                          <span className="font-mono">{c.name}</span>
                          {sort.col === c.name && (sort.dir === 'desc' ? <ArrowDown size={11} aria-hidden /> : <ArrowUp size={11} aria-hidden />)}
                        </button>
                      ) : <span className="font-mono">{c.name}</span>}
                      {c.pk && <span className="ml-1 text-[10px] font-normal text-stone-400">{t('manage.data.key')}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr
                    key={table.pk.length ? JSON.stringify(keyOfRow(table, r)) : i}
                    className={table.pk.length ? 'cursor-pointer border-b border-stone-100 last:border-0 hover:bg-stone-50/70' : 'border-b border-stone-100 last:border-0'}
                    onClick={table.pk.length ? () => onOpenRow(r) : undefined}
                  >
                    {cols.map((c) => (
                      <td key={c.name} className={`max-w-[16rem] truncate px-2 py-1.5 ${r[c.name] === null || r[c.name] === undefined ? 'text-stone-300' : 'text-stone-800'} ${c.kind === 'number' ? 'text-right tabular-nums' : ''}`} title={cellText(r[c.name])}>
                        {cellText(r[c.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
            <span>{t('manage.data.range', { from: offset + 1, to: offset + data.rows.length, total: data.more_than ? `${total}+` : total })}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={offset === 0 || rows.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('manage.data.previous')}</Button>
              <Button size="sm" variant="secondary" disabled={offset + data.rows.length >= total || rows.loading} onClick={() => setOffset(offset + PAGE)}>{t('manage.data.next')}</Button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/**
 * One field of a row: the editor of its kind, NULL as a box of its own (a new
 * row: "Default" for a column with one, which is then left to the database).
 */
function FieldEditor({ col, state, onChange, readOnly, isNew }) {
  const { t } = useTranslation()
  const set = (patch) => onChange({ ...state, ...patch })
  const disabled = readOnly || state.isNull
  const byDefault = isNew && col.has_default
  let input
  if (col.kind === 'bool') {
    input = <Select block value={state.text || 'false'} disabled={disabled} onChange={(e) => set({ text: e.target.value })} options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} />
  } else if (col.kind === 'enum' && col.enum) {
    input = <Select block value={state.text} disabled={disabled} onChange={(e) => set({ text: e.target.value })} placeholder="" options={col.enum.map((v) => ({ value: v, label: v }))} />
  } else if (col.kind === 'json' || col.kind === 'array' || (state.text || '').length > 80 || (state.text || '').includes('\n')) {
    input = <Textarea rows={col.kind === 'json' || col.kind === 'array' ? 6 : 3} value={state.text} disabled={disabled} onChange={(e) => set({ text: e.target.value })} className="font-mono text-xs" />
  } else {
    input = <Input value={state.text} disabled={disabled} numeric={col.kind === 'number'} onChange={(e) => set({ text: e.target.value })} className={col.kind === 'uuid' ? 'font-mono text-xs' : undefined} />
  }
  return (
    <div data-testid={`data-field-${col.name}`}>
      <Field
        label={<span className="font-mono">{col.name}</span>}
        hint={`${col.type}${col.pk ? ` · ${t('manage.data.key')}` : ''}${col.generated ? ` · ${t('manage.data.generated')}` : ''}`}
        error={state.error ? t(`manage.data.invalid.${state.error}`) : null}
      >
        {input}
      </Field>
      {!readOnly && (col.nullable || byDefault) && (
        <Checkbox className="mt-1" label={t(byDefault ? 'manage.data.useDefault' : 'manage.data.null')} checked={state.isNull} onChange={(e) => set({ isNull: e.target.checked })} />
      )}
    </div>
  )
}

const stateOf = (col, v) => ({ text: col.kind === 'bool' && v !== null && v !== undefined ? String(!!v) : editText(col, v), isNull: v === null || v === undefined, error: null })
const sameState = (a, b) => a.isNull === b.isNull && (a.isNull || a.text === b.text)

function RowPage({ table, rowKey, onBack, onSaved, onDeleted }) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const online = useOnline()
  const isNew = rowKey === null
  const loaded = usePanelData(() => admin.dataRow(table.name, rowKey), [table.name, JSON.stringify(rowKey)], { enabled: !isNew })
  const row = isNew ? null : loaded.data?.row
  const initial = useMemo(() => Object.fromEntries(table.columns.map((c) => [c.name, isNew ? { text: '', isNull: c.nullable || c.has_default, error: null } : stateOf(c, row?.[c.name])])), [table, row, isNew])
  const [fields, setFields] = useState(initial)
  useEffect(() => { setFields(initial) }, [initial])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const readOnly = !!table.read_only
  const editable = (c) => !readOnly && !c.generated && (isNew || !c.pk)
  const dirty = table.columns.filter((c) => editable(c) && fields[c.name] && !sameState(fields[c.name], initial[c.name]))

  if (!isNew && !row) return <PageMissing loading={loaded.loading} error={loaded.error} onBack={onBack} backLabel={table.name} />

  const save = async () => {
    const values = {}
    let bad = false
    const next = { ...fields }
    for (const c of dirty) {
      const r = parseField(c, fields[c.name])
      next[c.name] = { ...fields[c.name], error: r.error || null }
      if (r.error) bad = true
      // a new row's "Default": the database fills it in
      else if (!(isNew && c.has_default && fields[c.name].isNull)) values[c.name] = r.value
    }
    setFields(next)
    if (bad || dirty.length === 0 || (isNew && Object.keys(values).length === 0)) return
    setSaving(true)
    setError(null)
    const res = isNew
      ? await admin.dataInsert(table.name, values)
      : await admin.dataUpdate(table.name, { key: rowKey, before: Object.fromEntries(dirty.map((c) => [c.name, row[c.name] ?? null])), set: values })
    setSaving(false)
    if (res.error) {
      setError(res.error)
      return
    }
    toast.success(t(isNew ? 'manage.data.added' : 'manage.data.saved'))
    if (isNew) onSaved?.(res.data.row)
    else loaded.reload({ quiet: true })
  }

  const remove = async () => {
    const yes = await confirmDialog({
      title: t('manage.data.deleteTitle'),
      message: t('manage.data.deleteBody', { table: table.name }),
      confirmLabel: t('manage.data.delete'),
      tone: 'danger'
    })
    if (!yes) return
    setSaving(true)
    const res = await admin.dataDelete(table.name, rowKey)
    setSaving(false)
    if (res.error) {
      setError(res.error)
      return
    }
    toast.success(t('manage.data.deleted'))
    onDeleted?.()
  }

  const changed = error?.code === 'OV_DATA_CHANGED'
  return (
    <>
      <BackButton label={table.name} onClick={onBack} className="mb-3" />
      <PanelHead title={isNew ? t('manage.data.newRow') : <span className="font-mono text-base sm:text-lg">{table.pk.map((k) => String(rowKey[k])).join(' · ')}</span>} level={2}>
        {!isNew && !readOnly && (
          <Button size="sm" variant="danger-outline" icon={Trash2} onClick={remove} disabled={!online || saving}>{t('manage.data.delete')}</Button>
        )}
      </PanelHead>
      {readOnly && <Banner tone="info" icon={Lock} className="mb-3">{t(`manage.data.readOnlyLong.${table.read_only}`)}</Banner>}
      {changed && (
        <Banner tone="warning" className="mb-3" action={{ label: t('manage.data.reload'), onClick: () => { setError(null); loaded.reload() } }}>
          {t('manage.data.changedMeanwhile', { columns: (error.details?.columns || []).join(', ') })}
        </Banner>
      )}
      <div className="grid gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:grid-cols-2">
        {table.columns.map((c) => (
          <div key={c.name} className={c.kind === 'json' || c.kind === 'array' ? 'sm:col-span-2' : undefined}>
            <FieldEditor col={c} isNew={isNew} state={fields[c.name] || stateOf(c, null)} readOnly={!editable(c)} onChange={(s) => setFields((f) => ({ ...f, [c.name]: s }))} />
          </div>
        ))}
      </div>
      {error && !changed && <FormError className="mt-3">{errorLine(error, errorText)}</FormError>}
      {!readOnly && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={save} loading={saving} disabled={!online || saving || dirty.length === 0}>{t(isNew ? 'manage.data.add' : 'manage.data.save')}</Button>
          {dirty.length > 0 && <span className="text-xs text-stone-500">{t('manage.data.changedColumns', { columns: dirty.map((c) => c.name).join(', ') })}</span>}
          {!isNew && dirty.length > 0 && <Button variant="text" onClick={() => setFields(initial)}>{t('manage.data.discard')}</Button>}
        </div>
      )}
      {!readOnly && <p className="mt-3 text-xs text-stone-500">{t('manage.data.audited')}</p>}
    </>
  )
}
