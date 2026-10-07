import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Database } from 'lucide-react'
import { apiFrom } from '../lib/apiClient'
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

/**
 * The referee database picker of Match setup (1st / 2nd referee): a kit
 * Modal with a search field and the referees of the cloud referee_database.
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
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)

  // Load the referees each time the picker opens; the last list stays on
  // screen while it refreshes.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const { data, error } = await apiFrom('referee_database')
          .select('first_name, last_name, country, dob, created_at')
          .contains('sport_type', JSON.stringify([SPORT_TYPE]))
          .order('last_name', { ascending: true })
        if (cancelled) return
        if (error) {
          console.error('Error loading referees from history:', error)
          setOffline(error.network === true || error.status === 0)
          setReferees([])
          return
        }
        setOffline(false)
        // Unique already (unique index); map to the shape Match setup expects
        setReferees((data || []).map(ref => ({
          id: `${ref.last_name}_${ref.first_name}`.toLowerCase(),
          firstName: ref.first_name || '',
          lastName: ref.last_name || '',
          country: ref.country || 'CHE',
          dob: ref.dob || ''
        })))
      } catch (error) {
        if (cancelled) return
        console.error('Error loading referees:', error)
        setReferees([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  const filteredReferees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return referees
    return referees.filter(ref => `${ref.lastName || ''} ${ref.firstName || ''}`.toLowerCase().includes(query))
  }, [referees, searchQuery])

  const close = () => {
    setSearchQuery('') // fresh search next time
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
          </button>
        ))}
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
