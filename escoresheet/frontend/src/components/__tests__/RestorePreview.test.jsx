import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import en from '../../i18n/locales/en.json'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      let v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), en)
      if (typeof v !== 'string') return key
      for (const [k, val] of Object.entries(opts || {})) v = v.replaceAll(`{{${k}}}`, String(val))
      return v
    }
  })
}))

import RestorePreview from '../RestorePreview'

const data = {
  homeTeam: { name: 'VBC Rämi D1' },
  awayTeam: { name: 'VBC Einsiedeln D2' },
  sets: [{ index: 1, homePoints: 12, awayPoints: 9, finished: false }],
  events: [
    { setIndex: 1, seq: 1, type: 'lineup', payload: { team: 'home', lineup: { I: 2, II: 13, III: 4, IV: 7, V: 10, VI: 17 } } },
    { setIndex: 1, seq: 2, type: 'lineup', payload: { team: 'away', lineup: { I: 7, II: 5, III: 9, IV: 6, V: 8, VI: 4 } } },
    ...Array.from({ length: 21 }, (_, i) => ({ setIndex: 1, seq: 3 + i, type: 'point', payload: { team: i % 7 < 4 ? 'home' : 'away' } })),
    { setIndex: 1, seq: 30, type: 'substitution', payload: { team: 'home', position: 'II', playerOut: '13', playerIn: 6 } }
  ]
}

describe('RestorePreview', () => {
  it('shows the score of each substitution (no more "@0-0")', () => {
    render(<RestorePreview data={data} source="cloud" backupName="backup_g1_set1.json" />)
    const sub = screen.getByLabelText('#6 in for #13 at 12:9')
    expect(within(sub).getByText('12:9')).toBeInTheDocument()
    expect(screen.queryByText(/@0-0/)).toBeNull()
  })

  it('translated labels, the backup name without .json, the serving team', () => {
    render(<RestorePreview data={data} source="cloud" backupName="backup_g1_set1.json" />)
    expect(screen.getByText('Restore from cloud backup')).toBeInTheDocument()
    expect(screen.getByText('backup_g1_set1')).toBeInTheDocument()
    expect(screen.getByText('Serving:')).toBeInTheDocument()
    expect(screen.getByText('Set scores')).toBeInTheDocument()
    expect(screen.getAllByText('Time-outs')).toHaveLength(2)
    // the away team has none in this set
    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('the two team columns are cells of one grid, so a wrapped name moves both line-ups together', () => {
    const { container } = render(<RestorePreview data={data} source="local" />)
    const names = screen.getAllByTitle(/VBC (Rämi D1|Einsiedeln D2)/)
    expect(names).toHaveLength(2)
    expect(names[0].parentElement).toBe(names[1].parentElement)
    expect(names[0].parentElement.className).toContain('grid-cols-2')
    expect(container.textContent).not.toContain('Lineup')
  })
})
