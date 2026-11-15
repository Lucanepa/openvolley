import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { CompletionContext } from '@codemirror/autocomplete'

// The SQL tab (lib/sqlWorkspace.js): super admins, a Postgres console

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (typeof opts === 'string' ? opts : key), i18n: { language: 'en' } })
}))

const api = vi.hoisted(() => ({ admin: { sqlSchema: vi.fn(), sqlRun: vi.fn() } }))
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
// CodeMirror needs layout jsdom has not: a textarea with the same props stands in
vi.mock('../manage/sql/CodeMirrorEditor', () => ({
  default: ({ value, onChange, onExecute }) => (
    <textarea data-testid="sql-editor" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) onExecute() }} />
  )
}))

import SqlPanel, { applyIdentifierFix } from '../manage/sql/SqlPanel'
import { didYouMean, starterSelect, quoteIdent } from '../manage/sql/sqlSchema'
import { makeCompletionSource } from '../manage/sql/sqlCompletion'
import { parseSqlTemporal, formatSqlTemporal } from '../manage/sql/sqlCellDates'
import { toCSV, toTSV } from '../manage/sql/exportResults'
import { manageTabsFor } from '../manage/ManageConsole'
import { auditDetailsLine } from '../manage/AuditPanel'
import { accessFromRoles } from '../../lib/access'

const TABLES = [
  { name: 'matches', columns: [{ name: 'id', data_type: 'uuid', nullable: false, pk: true }, { name: 'game_n', data_type: 'integer', nullable: true }, { name: 'status', data_type: 'text', nullable: true, values: ['final', 'live'] }] },
  { name: 'match_editors', columns: [{ name: 'match_id', data_type: 'uuid', nullable: false, pk: true, ref: 'matches.id' }, { name: 'user_id', data_type: 'uuid', nullable: false, pk: true }] }
]
const editorTables = TABLES.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, dataType: c.data_type, values: c.values, pk: c.pk, ref: c.ref })) }))
const ok = (data) => ({ data, error: null, status: 200 })

beforeEach(() => {
  vi.clearAllMocks()
  ui.toasts = []
  localStorage.clear()
  api.admin.sqlSchema.mockResolvedValue(ok({ tables: TABLES, server_version: '17.11' }))
})

describe('SQL tab helpers', () => {
  it('the tab: super admins only', () => {
    expect(manageTabsFor(accessFromRoles(['super_admin']))).toContain('sql')
    expect(manageTabsFor(accessFromRoles(['admin']))).not.toContain('sql')
  })
  it('did you mean: a column scoped to the query, and the fix keeps the alias', () => {
    const sql = 'select me.match_idd from match_editors me'
    const fix = didYouMean('column me.match_idd does not exist', sql, editorTables)
    expect(fix.suggestions).toEqual(['me.match_id'])
    expect(applyIdentifierFix(sql, fix, 'me.match_id')).toBe('select me.match_id from match_editors me')
    expect(didYouMean('relation "matchs" does not exist', 'select 1 from matchs', editorTables).suggestions).toContain('matches')
  })
  it('a starter SELECT and quoted identifiers', () => {
    expect(starterSelect(TABLES[0])).toBe('SELECT * FROM matches LIMIT 100;')
    expect(quoteIdent('user')).toBe('"user"')
    expect(quoteIdent('game_n')).toBe('game_n')
  })
  it('completion: an alias gives only its table\'s columns; after = the values the column holds', () => {
    const source = makeCompletionSource(editorTables)
    const at = (doc) => source(new CompletionContext(EditorState.create({ doc }), doc.length, true))
    expect(at('select me. from match_editors me'.slice(0, 10)).options.map((o) => o.label)).toEqual(['match_id', 'user_id'])
    expect(at("select * from matches where status = ").options.map((o) => o.label)).toEqual(["'final'", "'live'"])
    expect(at('select * from ma').options.map((o) => o.label)).toEqual(expect.arrayContaining(['matches', 'match_editors']))
  })
  it('dates: a date stays a day, an instant shows in Zurich time', () => {
    expect(formatSqlTemporal(parseSqlTemporal('2026-09-15'))).toBe('15.09.2026')
    expect(formatSqlTemporal(parseSqlTemporal('2026-07-01 10:00:00+00'))).toBe('01.07.2026 12:00')
    expect(parseSqlTemporal('15.09.2026')).toBeNull()
  })
  it('exports: CSV quotes and defuses formulas; TSV keeps one line per row', () => {
    expect(toCSV(['a', 'b'], [['x,y', '=SUM(1)'], [null, -5]])).toBe('a,b\n"x,y",\'=SUM(1)\n,-5')
    expect(toTSV(['a'], [['two\nlines']])).toBe('a\ntwo lines')
  })
  it('the audit line of a SQL run', () => {
    expect(auditDetailsLine({ action: 'sql.write', details: { committed: true, affected: 3, sql: "update clubs set name = '?'" } })).toBe("Saved · 3 · update clubs set name = '?'")
    expect(auditDetailsLine({ action: 'sql.read', details: { rows: 2, sql: 'select 1' } })).toBe('2 rows · select 1')
  })
})

describe('SqlPanel', () => {
  it('loads the tables; a run shows the rows; Ctrl+Enter runs too', async () => {
    api.admin.sqlRun.mockResolvedValue(ok({ columns: ['game_n', 'status'], rows: [[4711, 'final'], [4712, null]], row_count: 2, duration_ms: 3, truncated: false, statements: 1, write_mode: false, committed: false }))
    render(<SqlPanel />)
    expect(await within(screen.getAllByTestId('sql-schema')[0]).findByText('matches')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('sql-editor'), { target: { value: 'select game_n, status from matches' } })
    fireEvent.click(screen.getByText('manage.sql.run'))
    await waitFor(() => expect(api.admin.sqlRun).toHaveBeenCalledWith({ sql: 'select game_n, status from matches', writeMode: false, commit: false }))
    const results = await screen.findByTestId('sql-results')
    expect(within(results).getByText('4711')).toBeInTheDocument()
    expect(within(results).getByText('NULL')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('sql-editor'), { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(api.admin.sqlRun).toHaveBeenCalledTimes(2))
    // the query is kept in this browser's recent list
    expect(JSON.parse(localStorage.getItem('ov-sql-recent'))[0].sql).toBe('select game_n, status from matches')
  })

  it('a table\'s SELECT button fills the editor', async () => {
    render(<SqlPanel />)
    const schema = screen.getAllByTestId('sql-schema')[0]
    await within(schema).findByText('matches')
    fireEvent.click(within(schema).getAllByText('SELECT')[0])
    expect(screen.getByTestId('sql-editor').value).toBe('SELECT * FROM matches LIMIT 100;')
  })

  it('write mode: Preview first, Commit asks and runs the same SQL with commit; an edit voids the preview', async () => {
    api.admin.sqlRun
      .mockResolvedValueOnce(ok({ columns: ['command', 'rowCount'], rows: [['UPDATE', 3]], row_count: 1, duration_ms: 4, truncated: false, statements: 1, write_mode: true, committed: false }))
      .mockResolvedValueOnce(ok({ columns: ['command', 'rowCount'], rows: [['UPDATE', 3]], row_count: 1, duration_ms: 4, truncated: false, statements: 1, write_mode: true, committed: true }))
    render(<SqlPanel />)
    await screen.findAllByTestId('sql-schema')
    fireEvent.click(screen.getByRole('switch', { name: 'manage.sql.writeMode' }))
    fireEvent.change(screen.getByTestId('sql-editor'), { target: { value: "update matches set status = 'final' where game_n = 1" } })
    fireEvent.click(screen.getByText('manage.sql.preview'))
    const banner = await screen.findByTestId('sql-preview')
    expect(within(banner).getByText('manage.sql.previewCount')).toBeInTheDocument()
    fireEvent.click(within(banner).getByText('manage.sql.commit'))
    await waitFor(() => expect(api.admin.sqlRun).toHaveBeenLastCalledWith({ sql: "update matches set status = 'final' where game_n = 1", writeMode: true, commit: true }))
    expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'manage.sql.commitTitle', tone: 'danger' }))
    expect(ui.toasts).toContainEqual(['ok', 'manage.sql.committed'])
    expect(screen.queryByTestId('sql-preview')).toBeNull()
  })

  it('a preview whose SQL was edited cannot be committed', async () => {
    api.admin.sqlRun.mockResolvedValue(ok({ columns: ['command', 'rowCount'], rows: [['DELETE', 1]], row_count: 1, duration_ms: 4, truncated: false, statements: 1, write_mode: true, committed: false }))
    render(<SqlPanel />)
    await screen.findAllByTestId('sql-schema')
    fireEvent.click(screen.getByRole('switch', { name: 'manage.sql.writeMode' }))
    fireEvent.change(screen.getByTestId('sql-editor'), { target: { value: 'delete from match_editors where user_id = null' } })
    fireEvent.click(screen.getByText('manage.sql.preview'))
    await screen.findByTestId('sql-preview')
    fireEvent.change(screen.getByTestId('sql-editor'), { target: { value: 'delete from match_editors' } })
    const banner = screen.getByTestId('sql-preview')
    expect(within(banner).queryByText('manage.sql.commit')).toBeNull()
    expect(within(banner).getByText('manage.sql.previewStale')).toBeInTheDocument()
  })

  it('an error shows the database\'s words, its hint and a one-tap fix', async () => {
    api.admin.sqlRun.mockResolvedValue({ data: null, status: 400, error: { code: '42703', message: 'column "gam_n" does not exist', details: { hint: 'Perhaps you meant to reference the column "matches.game_n".', statement_index: 0 } } })
    render(<SqlPanel />)
    await screen.findAllByTestId('sql-schema')
    fireEvent.change(screen.getByTestId('sql-editor'), { target: { value: 'select gam_n from matches' } })
    fireEvent.click(screen.getByText('manage.sql.run'))
    const err = await screen.findByTestId('sql-error')
    expect(within(err).getByText('column "gam_n" does not exist')).toBeInTheDocument()
    expect(within(err).getByText(/Perhaps you meant/)).toBeInTheDocument()
    fireEvent.click(within(err).getByText('game_n'))
    expect(screen.getByTestId('sql-editor').value).toBe('select game_n from matches')
  })
})
