import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, opts) => (opts && typeof opts === 'object' && 'count' in opts ? `${key}:${opts.count}` : key), i18n: { language: 'en' } })
}))

import PlayerPoolModal from '../PlayerPoolModal'
import { buildPlayerPool } from '../../domain/playerPool'

const p = (number, lastName, over = {}) => ({ number, lastName, firstName: 'A', dob: '', libero: '', isCaptain: false, isLfp: false, ...over })

describe('PlayerPoolModal', () => {
  it('ticks the players of the last match and hands back the ticked ones', () => {
    const pool = buildPlayerPool({ saved: [p(1, 'Alpha'), p(2, 'Beta'), p(3, 'Gamma')], earlier: [[p(2, 'Beta'), p(3, 'Gamma')]] })
    const onApply = vi.fn()
    render(<PlayerPoolModal open pool={pool} teamLabel="VBC Seefeld" onApply={onApply} onClose={() => {}} />)
    const boxes = screen.getAllByTestId('player-pool-row')
    expect(boxes.map(b => b.checked)).toEqual([false, true, true])
    expect(screen.getByTestId('player-pool-apply').textContent).toBe('playerPool.apply:2')
    fireEvent.click(boxes[0])
    fireEvent.click(screen.getByTestId('player-pool-apply'))
    expect(onApply.mock.calls[0][0].map(e => e.number)).toEqual([1, 2, 3])
  })

  it('selects all or none, disables "Use" with none and warns above 14', () => {
    const pool = buildPlayerPool({ imported: Array.from({ length: 16 }, (_, i) => p(i + 1, `P${i + 1}`)) })
    render(<PlayerPoolModal open pool={pool} onApply={() => {}} onClose={() => {}} />)
    expect(screen.getByTestId('player-pool-warnings').textContent).toContain('playerPool.tooMany')
    fireEvent.click(screen.getByTestId('player-pool-none'))
    expect(screen.getByTestId('player-pool-apply').disabled).toBe(true)
    expect(screen.queryByTestId('player-pool-warnings')).toBeNull()
    fireEvent.click(screen.getByTestId('player-pool-all'))
    expect(screen.getAllByTestId('player-pool-row').every(b => b.checked)).toBe(true)
  })

  // 360 px at 130 % text: "HOFMANN Jo…", "BRUNNER Da…" (one line, cut):
  // the first name that tells namesakes apart was hidden
  it('a name takes up to two lines, never cut to one', () => {
    const pool = buildPlayerPool({ saved: [p(4, 'Hofmann', { firstName: 'Jonas-Maximilian' })] })
    render(<PlayerPoolModal open pool={pool} onApply={() => {}} onClose={() => {}} />)
    const name = screen.getByTestId('player-pool-name')
    expect(name.textContent).toBe('HOFMANN Jonas-Maximilian')
    expect(name.className).toContain('line-clamp-2')
    expect(name.className).not.toMatch(/\btruncate\b/)
    expect(name.getAttribute('title')).toBe('HOFMANN Jonas-Maximilian')
  })

  it('says so when no player is known', () => {
    render(<PlayerPoolModal open pool={[]} onApply={() => {}} onClose={() => {}} />)
    expect(screen.getByText('playerPool.empty')).toBeTruthy()
  })
})
