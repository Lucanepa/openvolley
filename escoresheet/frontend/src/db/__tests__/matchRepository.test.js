import { describe, it, expect } from 'vitest'
import {
  VALID_MATCH_COLUMNS,
  JSONB_COLUMNS,
  filterMatchPayload,
  hasJsonbColumns,
  mergeJsonbColumns,
} from '../matchRepository'

describe('matchRepository', () => {
  describe('VALID_MATCH_COLUMNS', () => {
    it('includes sport_type (the column backupManager used to drop)', () => {
      expect(VALID_MATCH_COLUMNS).toContain('sport_type')
    })
    it('includes the core match columns', () => {
      for (const c of ['external_id', 'status', 'home_team', 'away_team', 'set_results']) {
        expect(VALID_MATCH_COLUMNS).toContain(c)
      }
    })
  })

  describe('filterMatchPayload', () => {
    it('keeps valid columns and drops unknown ones', () => {
      const out = filterMatchPayload({ external_id: 'x', sport_type: 'indoor', bogus_col: 1, id: 'uuid' })
      expect(out).toEqual({ external_id: 'x', sport_type: 'indoor' })
      expect(out).not.toHaveProperty('bogus_col')
      expect(out).not.toHaveProperty('id')
    })
    it('handles null/non-object safely', () => {
      expect(filterMatchPayload(null)).toEqual({})
      expect(filterMatchPayload(undefined)).toEqual({})
    })
  })

  describe('JSONB_COLUMNS / hasJsonbColumns', () => {
    it('detects a jsonb column in an update', () => {
      expect(hasJsonbColumns({ status: 'live' })).toBe(false)
      expect(hasJsonbColumns({ connections: {} })).toBe(true)
      expect(JSONB_COLUMNS).toContain('connection_pins')
    })
  })

  describe('mergeJsonbColumns', () => {
    it('merges jsonb keys over existing without dropping siblings', () => {
      const existing = { connections: { referee_enabled: true, home_bench_enabled: true }, status: 'live' }
      const update = { connections: { home_bench_enabled: false }, status: 'setup' }
      const merged = mergeJsonbColumns(update, existing)
      expect(merged.connections).toEqual({ referee_enabled: true, home_bench_enabled: false })
      expect(merged.status).toBe('setup') // non-jsonb replaced, not merged
    })
    it('passes through when there is no existing row', () => {
      expect(mergeJsonbColumns({ connections: { a: 1 } }, null)).toEqual({ connections: { a: 1 } })
    })
  })
})
