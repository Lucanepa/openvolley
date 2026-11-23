import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
import { apiFrom } from '../lib/apiClient'
import { sortRows } from '../lib/selectAll'
import KitModal from './manage/KitModal'
import { SearchInput, SkeletonRows, EmptyInset } from '../ui'
import { FOCUS_RING_INSET } from '../ui/Button.jsx'
import { cn } from '../ui/cn.js'
import { PICKER_RESULTS } from './pickerLayout'

// Sport type for indoor volleyball
const SPORT_TYPE = 'indoor'

const ROW = cn(
  'flex w-full min-h-11 items-center rounded-lg bg-transparent px-3 text-left text-sm font-medium text-stone-800 hover:bg-stone-100 transition-colors',
  FOCUS_RING_INSET
)

const nameKey = (r) => `${r.lastName}\u0000${r.firstName}`.trim().toLowerCase()

// The referees one answer holds (PERM-07, audit 2611): the directory is
// searched on the server, by name prefix, never loaded whole. It used to be
// read whole through selectAll, which gives up past 200,000 rows (a flood
// left every picker empty), and every open downloaded all of it.
export const REFEREE_PICKER_LIMIT = 100
// Typing waits this long before it asks the server
export const REFEREE_SEARCH_DEBOUNCE_MS = 250

/**
 * The typed text as a prefix pattern of /api/db's ilike (backend
 * lib/pgQuery.js: `*` is any text), or null for nothing typed. The pattern
 * characters the user typed are dropped, not matched.
 */
export function prefixPattern(text) {
  const t = String(text ?? '').replace(/[%_*\\]/g, '').replace(/\s+/g, ' ').trim()
  return t ? `${t}*` : null
}

const directory = () => apiFrom('referee_database')
  .select('id, first_name, last_name, country, created_at')
  .contains('sport_type', JSON.stringify([SPORT_TYPE]))
const firstPage = (q) => q.order('last_name', { ascending: true }).limit(REFEREE_PICKER_LIMIT)

/**
 * The directory rows for what was typed: nothing typed, the first
 * REFEREE_PICKER_LIMIT by last name; else those whose last or first name
 * starts with it (and, for "Last First", whose last name starts with its
 * first word), each lookup at most REFEREE_PICKER_LIMIT. Rows by last name
 * (as selectAll sorted them: accented names by the locale), each once.
 * { data, error } like one request.
 */
export async function searchReferees(text) {
  const whole = prefixPattern(text)
  if (!whole) {
    const r = await firstPage(directory())
    return r?.error ? r : { ...r, data: sortRows(r?.data || [], [{ column: 'last_name' }]) }
  }
  const lookups = [
    firstPage(directory().ilike('last_name', whole)),
    firstPage(directory().ilike('first_name', whole))
  ]
  const word = prefixPattern(String(text).trim().split(/\s+/)[0])
  if (word && word !== whole) lookups.push(firstPage(directory().ilike('last_name', word)))
  const answers = await Promise.all(lookups)
  const failed = answers.find((a) => a?.error)
  if (failed) return failed
  const byId = new Map()
  for (const a of answers) for (const row of a?.data || []) if (!byId.has(row.id)) byId.set(row.id, row)
  return { data: sortRows([...byId.values()], [{ column: 'last_name' }]), error: null }
}

/**
 * The directory rows with a `detail` for a name that occurs more than once:
 * the licence number when the row has one. No date of birth tells namesakes
 * apart any more (db/048: the directory keeps none); without a licence the
 * row has no detail.
 */
export function withNameDetails(referees) {
  const byName = new Map()
  for (const r of referees) byName.set(nameKey(r), (byName.get(nameKey(r)) || 0) + 1)
  return referees.map((r) => {
    if (byName.get(nameKey(r)) < 2) return r
    const lic = String(r.licence ?? '').trim()
    return lic ? { ...r, detail: lic } : r
  })
}

/**
 * The referee database picker of Match setup (1st / 2nd referee): a kit
 * Modal with a search field and the referees of the cloud referee_database,
 * searched on the server (searchReferees): the first ones by last name on
 * open, the matching ones as the user types.
 *
 * Its box never changes size (pickerLayout.js): the panel width comes from
 * the kit Modal (`size="md"`), and the result area has a fixed height that the
 * skeleton, the empty message and the list all fill alike. No open animation.
 *
 * @param {boolean} open
 * @param {function} onClose
 * @param {function} onSelect (referee) => void
 */
export default function RefereeSelector({ open, onClose, onSelect }) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [referees, setReferees] = useState([])
  // true from the moment the picker opens until this open's response is in,
  // so the first frame already shows the skeleton (not a stale "no referees")
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  // The last answer was cut at REFEREE_PICKER_LIMIT: typing finds the others
  const [more, setMore] = useState(false)
  // What the server is asked for: the search text, a moment after typing
  const [asked, setAsked] = useState('')

  useEffect(() => {
    if (!open) return
    const text = searchQuery.trim()
    if (text === asked) return
    const timer = setTimeout(() => setAsked(text), REFEREE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, searchQuery, asked])

  // Load the referees each time the picker opens and for each search; the
  // last list stays on screen (filtered as the user types) while it refreshes.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const { data, error } = await searchReferees(asked)
        if (cancelled) return
        if (error) {
          console.error('Error loading referees from history:', error)
          setOffline(error.network === true || error.status === 0)
          setReferees([])
          return
        }
        setOffline(false)
        setMore(!asked && (data || []).length >= REFEREE_PICKER_LIMIT)
        // Map to the shape Match setup expects (no date of birth: db/048).
        // Names are not unique in the directory (two people, or one entered
        // twice): rows are keyed by their id, and same names show a licence
        // number where the row has one.
        setReferees(withNameDetails((data || []).map((ref, i) => ({
          id: ref.id != null ? String(ref.id) : `${ref.last_name}_${ref.first_name}_${i}`.toLowerCase(),
          firstName: ref.first_name || '',
          lastName: ref.last_name || '',
          country: ref.country || 'CHE',
          ...(ref.licence ? { licence: String(ref.licence) } : {})
        }))))
      } catch (error) {
        if (cancelled) return
        console.error('Error loading referees:', error)
        setReferees([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      setLoading(true) // the next open or search starts as loading again
    }
  }, [open, asked])

  const filteredReferees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return referees
    return referees.filter(ref => `${ref.lastName || ''} ${ref.firstName || ''}`.toLowerCase().includes(query))
  }, [referees, searchQuery])

  const close = () => {
    setSearchQuery('') // fresh search next time
    setAsked('')
    onClose()
  }

  let results
  if (loading && referees.length === 0) {
    results = <SkeletonRows rows={5} pill={false} />
  } else if (filteredReferees.length === 0) {
    results = (
      <EmptyInset className="text-center">
        {searchQuery
          ? t('refereeSelector.noRefereesFound')
          : offline ? t('refereeSelector.connectToInternet') : t('refereeSelector.noRefereeHistory')}
      </EmptyInset>
    )
  } else {
    results = (
      <div className="flex flex-col gap-1">
        {filteredReferees.map((referee) => (
          <button
            key={referee.id}
            type="button"
            className={ROW}
            onClick={() => {
              onSelect(referee)
              close()
            }}
          >
            <span className="min-w-0 truncate">{referee.lastName}, {referee.firstName}</span>
            {referee.detail && <span className="ml-auto shrink-0 pl-3 text-xs font-normal tabular-nums text-stone-500">{referee.detail}</span>}
          </button>
        ))}
        {more && !searchQuery.trim() && (
          <p data-testid="referee-picker-more" className="px-3 py-2 text-xs text-stone-500">{t('refereeSelector.typeToSearch')}</p>
        )}
      </div>
    )
  }

  return (
    <KitModal
      open={open}
      onClose={close}
      layout="sections"
      size="md"
      title={t('refereeSelector.title')}
      icon={Database}
      closeLabel={t('common.close', 'Close')}
      bodyClassName="space-y-3"
    >
      <div data-referee-selector data-testid="referee-picker" className="flex flex-col gap-3">
        <SearchInput
          size="lg"
          aria-label={t('refereeSelector.searchReferees')}
          placeholder={t('refereeSelector.searchReferees')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          data-autofocus=""
        />
        <div
          data-testid="referee-picker-list"
          className={cn(PICKER_RESULTS, '-mx-2 px-2')}
          aria-busy={loading || undefined}
        >
          {results}
        </div>
      </div>
    </KitModal>
  )
}
