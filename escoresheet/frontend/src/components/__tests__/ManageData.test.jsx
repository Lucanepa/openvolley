import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// The Data tab (lib/dataAdmin.js): super admins, every table one row at a time

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({
  admin: { dataTables: vi.fn(), dataRows: vi.fn(), dataRow: vi.fn(), dataInsert: vi.fn(), dataUpdate: vi.fn(), dataDelete: vi.fn() }
}))
vi.mock('../../lib/accountApi', async (orig) => ({ ...(await orig()), admin: api.admin }))
const ui = vi.hoisted(() => ({ confirm: vi.fn(async () => true), toasts: [] }))
vi.mock('../../ui', async (orig) => {
  const real = await orig()
  return {
    ...real,
    confirmDialog: (...a) => ui.confirm(...a),
    toast: { ...real.toast, success: (m) => ui.toasts.push(['ok', m]), error: (m) => ui.toasts.push(['error', m]) }
  }
})

import DataPanel, { cellText, editText, parseField } from '../manage/DataPanel'
import { manageTabsFor } from '../manage/ManageConsole'
import { auditDetailsLine } from '../manage/AuditPanel'
import { accessFromRoles } from '../../lib/access'

const CLUBS = {
  name: 'clubs',
  pk: ['id'],
  read_only: null,
  estimate: 2,
  secret_columns: [],
  columns: [
    { name: 'id', type: 'uuid', kind: 'uuid', nullable: false, has_default: true, generated: false, pk: true },
    { name: 'name', type: 'text', kind: 'text', nullable: false, has_default: false, generated: false, pk: false },
    { name: 'contact_email', type: 'text', kind: 'text', nullable: true, has_default: false, generated: false, pk: false }
  ]
}
const AUDIT = { name: 'audit_log', pk: ['id'], read_only: 'log', estimate: 9, secret_columns: [], columns: [{ name: 'id', type: 'bigint', kind: 'number', nullable: false, has_default: true, generated: true, pk: true }] }
const MATCHES = { name: 'matches', pk: ['id'], read_only: null, estimate: 1, secret_columns: ['game_pin', 'connection_pins'], columns: [{ name: 'id', type: 'uuid', kind: 'uuid', nullable: false, has_default: true, generated: false, pk: true }] }
const C1 = { id: 'c1', name: 'VBC Musterdorf', contact_email: 'info@example.ch' }
const ok = (data) => ({ data, error: null, status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  ui.confirm.mockResolvedValue(true)
  api.admin.dataTables.mockResolvedValue(ok({ schema: 'public', tables: [AUDIT, CLUBS, MATCHES] }))
  api.admin.dataRows.mockResolvedValue(ok({ table: 'clubs', rows: [C1, { id: 'c2', name: 'VBC Other', contact_email: null }], total: 2, more_than: false, limit: 50, offset: 0 }))
  api.admin.dataRow.mockResolvedValue(ok({ table: 'clubs', row: C1 }))
})

describe('Data tab helpers', () => {
  it('cells: null as a dash, cut values end in …, json as JSON', () => {
    expect(cellText(null)).toBe('—')
    expect(cellText({ $cut: 'abc', $len: 400 })).toBe('abc…')
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText(false)).toBe('false')
  })
  it('fields: json parsed (and refused when broken), NULL, text as typed', () => {
    const json = { kind: 'json' }
    expect(parseField(json, { text: '{"a":1}', isNull: false })).toEqual({ value: { a: 1 } })
    expect(parseField(json, { text: '{a', isNull: false })).toEqual({ error: 'json' })
    expect(parseField({ kind: 'array' }, { text: '{}', isNull: false })).toEqual({ error: 'array' })
    expect(parseField({ kind: 'number' }, { text: '12', isNull: false })).toEqual({ value: '12' })
    expect(parseField({ kind: 'bool' }, { text: 'true', isNull: false })).toEqual({ value: true })
    expect(parseField({ kind: 'text' }, { text: 'x', isNull: true })).toEqual({ value: null })
    expect(editText(json, { a: 1 })).toBe('{\n  "a": 1\n}')
  })
  it('the tab: super admins only', () => {
    expect(manageTabsFor(accessFromRoles(['super_admin']))).toContain('data')
    expect(manageTabsFor(accessFromRoles(['admin']))).not.toContain('data')
    expect(manageTabsFor(accessFromRoles(['competition_manager']))).not.toContain('data')
  })
  it('the audit line of a change: table, key, before → after', () => {
    const line = auditDetailsLine({ action: 'data.update', details: { table: 'matches', key: { id: 'm1' }, before: { game_n: 4711, officials: '[json]' }, after: { game_n: 4712, officials: '[json]' } } })
    expect(line).toBe('matches · m1 · game_n: 4711 → 4712, officials: [json] → [json]')
    expect(auditDetailsLine({ action: 'data.delete', details: { table: 'clubs', key: { id: 'c1' }, values: { name: '[personal]' } } })).toBe('clubs · c1 · name')
  })
})

describe('DataPanel', () => {
  it('lists the tables with their read-only ones marked; a table opens its rows', async () => {
    const onRoute = vi.fn()
    const { rerender } = render(<DataPanel route="" onRoute={onRoute} />)
    expect(await screen.findByText('clubs')).toBeInTheDocument()
    expect(screen.getByText('manage.data.readOnly.log')).toBeInTheDocument()
    fireEvent.click(screen.getByText('clubs'))
    expect(onRoute).toHaveBeenCalledWith('clubs', { push: true })

    rerender(<DataPanel route="clubs" onRoute={onRoute} />)
    const rows = await screen.findByTestId('data-rows')
    expect(within(rows).getByText('VBC Musterdorf')).toBeInTheDocument()
    expect(within(rows).getByText('—')).toBeInTheDocument()
    expect(api.admin.dataRows).toHaveBeenCalledWith('clubs', expect.objectContaining({ limit: 50, offset: 0 }))
    fireEvent.click(within(rows).getByText('VBC Musterdorf'))
    expect(onRoute).toHaveBeenLastCalledWith(`clubs/row/${encodeURIComponent(JSON.stringify({ id: 'c1' }))}`, { push: true })
  })

  it('a filter and a sort go to the server', async () => {
    render(<DataPanel route="clubs" onRoute={() => {}} />)
    await screen.findByTestId('data-rows')
    fireEvent.change(screen.getByLabelText('manage.data.filterColumn'), { target: { value: 'contact_email' } })
    fireEvent.change(screen.getByLabelText('manage.data.filterOp'), { target: { value: 'null' } })
    fireEvent.click(screen.getByText('manage.data.apply'))
    await waitFor(() => expect(api.admin.dataRows).toHaveBeenLastCalledWith('clubs', expect.objectContaining({ col: 'contact_email', op: 'null', val: undefined })))
    fireEvent.click(screen.getAllByLabelText('manage.data.sortBy')[1])
    await waitFor(() => expect(api.admin.dataRows).toHaveBeenLastCalledWith('clubs', expect.objectContaining({ sort: 'name', dir: 'asc' })))
  })

  it('a row: only the changed column is sent, with the value it was read with; the key cannot be edited', async () => {
    api.admin.dataUpdate.mockResolvedValue(ok({ table: 'clubs', row: { ...C1, contact_email: 'board@example.ch' } }))
    render(<DataPanel route={`clubs/row/${encodeURIComponent(JSON.stringify({ id: 'c1' }))}`} onRoute={() => {}} />)
    const email = await screen.findByDisplayValue('info@example.ch')
    expect(screen.getByDisplayValue('c1')).toBeDisabled()
    fireEvent.change(email, { target: { value: 'board@example.ch' } })
    fireEvent.click(screen.getByText('manage.data.save'))
    await waitFor(() => expect(api.admin.dataUpdate).toHaveBeenCalledWith('clubs', {
      key: { id: 'c1' },
      before: { contact_email: 'info@example.ch' },
      set: { contact_email: 'board@example.ch' }
    }))
    expect(ui.toasts).toContainEqual(['ok', 'manage.data.saved'])
  })

  it('a row changed meanwhile: the warning names the columns and offers a reload', async () => {
    api.admin.dataUpdate.mockResolvedValue({ data: null, status: 409, error: { code: 'OV_DATA_CHANGED', message: 'changed', details: { columns: ['contact_email'], current: { contact_email: 'x@example.ch' } } } })
    render(<DataPanel route={`clubs/row/${encodeURIComponent(JSON.stringify({ id: 'c1' }))}`} onRoute={() => {}} />)
    fireEvent.change(await screen.findByDisplayValue('info@example.ch'), { target: { value: 'y@example.ch' } })
    fireEvent.click(screen.getByText('manage.data.save'))
    expect(await screen.findByText('manage.data.changedMeanwhile')).toBeInTheDocument()
    expect(screen.getByText('manage.data.reload')).toBeInTheDocument()
  })

  it('delete asks first; a database refusal shows its own words', async () => {
    api.admin.dataDelete.mockResolvedValue({ data: null, status: 409, error: { code: 'OV_DATA_REFERENCED', message: 'update or delete on table "clubs" violates foreign key constraint' } })
    render(<DataPanel route={`clubs/row/${encodeURIComponent(JSON.stringify({ id: 'c1' }))}`} onRoute={() => {}} />)
    await screen.findByDisplayValue('info@example.ch')
    fireEvent.click(screen.getByText('manage.data.delete'))
    await waitFor(() => expect(api.admin.dataDelete).toHaveBeenCalledWith('clubs', { id: 'c1' }))
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.data.deleteTitle', tone: 'danger' }))
    expect(await screen.findByText(/violates foreign key constraint/)).toBeInTheDocument()
  })

  it('a log table is read-only: no add, no save', async () => {
    api.admin.dataRow.mockResolvedValue(ok({ table: 'audit_log', row: { id: 7 } }))
    render(<DataPanel route={`audit_log/row/${encodeURIComponent(JSON.stringify({ id: 7 }))}`} onRoute={() => {}} />)
    expect(await screen.findByText('manage.data.readOnlyLong.log')).toBeInTheDocument()
    expect(screen.queryByText('manage.data.save')).toBeNull()
    expect(screen.queryByText('manage.data.delete')).toBeNull()
  })

  it('a new row sends only the fields filled in (defaults left to the database)', async () => {
    api.admin.dataInsert.mockResolvedValue(ok({ table: 'clubs', row: { id: 'c9', name: 'VBC Neu', contact_email: null } }))
    const onRoute = vi.fn()
    render(<DataPanel route="clubs/new" onRoute={onRoute} />)
    const name = within(await screen.findByTestId('data-field-name')).getByRole('textbox')
    fireEvent.change(name, { target: { value: 'VBC Neu' } })
    fireEvent.click(screen.getByText('manage.data.add'))
    await waitFor(() => expect(api.admin.dataInsert).toHaveBeenCalledWith('clubs', { name: 'VBC Neu' }))
    expect(onRoute).toHaveBeenLastCalledWith(`clubs/row/${encodeURIComponent(JSON.stringify({ id: 'c9' }))}`, { push: false })
  })
})
