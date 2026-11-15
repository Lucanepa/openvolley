import { useTranslation } from 'react-i18next'
import { parseSqlTemporal, formatSqlTemporal } from './sqlCellDates'

/*
 * The result grid of the SQL tab: one scroller for both axes, sticky header
 * and row numbers, NULL marked, dates in Swiss form (the raw value on hover),
 * long values cut at 120 characters (whole in the tooltip and the exports).
 */

function cell(value) {
  if (value === null || value === undefined) return <span className="italic text-stone-400">NULL</span>
  if (typeof value === 'boolean') return <span className={value ? 'text-emerald-700' : 'text-red-700'}>{String(value)}</span>
  const temporal = parseSqlTemporal(value)
  if (temporal) return <span className="text-stone-600" title={String(value)}>{formatSqlTemporal(temporal)}</span>
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return str.length > 120 ? <span title={str}>{str.slice(0, 120)}…</span> : str
}

export default function ResultsTable({ columns, rows }) {
  const { t } = useTranslation()
  if (!columns.length) return <p className="py-4 text-center text-sm text-stone-500">{t('manage.sql.noColumns')}</p>
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm" data-testid="sql-results">
      <div className="max-h-[55vh] overflow-auto">
        <table className="min-w-full text-left text-xs">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 top-0 z-30 w-10 whitespace-nowrap border-b border-r border-stone-200 bg-stone-100 px-2 py-1.5 text-right font-semibold text-stone-500">#</th>
              {columns.map((c, i) => (
                <th key={`${c}-${i}`} scope="col" className="sticky top-0 z-20 whitespace-nowrap border-b border-stone-200 bg-stone-100 px-2 py-1.5 font-mono font-semibold text-stone-700">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i % 2 ? 'bg-stone-50/60' : undefined}>
                <td className="sticky left-0 z-10 whitespace-nowrap border-r border-stone-200 bg-white px-2 py-1 text-right font-mono tabular-nums text-stone-400">{i + 1}</td>
                {row.map((v, j) => (
                  <td key={j} className="whitespace-nowrap px-2 py-1 font-mono text-stone-800">{cell(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
