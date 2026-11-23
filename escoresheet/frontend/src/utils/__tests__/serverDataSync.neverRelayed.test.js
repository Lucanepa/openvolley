// A Global match's capability fields stay on the scorer device (audit SEC-28):
// the tournament code (globalOrganizer), the share link (cloudShareToken), the
// backup key (globalKey) and the live screen's court secret (liveSecret) are
// not in the match row any relay hands to the tablets (relayMatchPayload).
import { describe, it, expect } from 'vitest'
import { relayMatchPayload } from '../serverDataSync'

describe('relayMatchPayload: never relayed', () => {
  it('leaves out the tournament code, the share link, the backup key and the live screen secret', () => {
    const { match } = relayMatchPayload({
      id: 1, seed_key: 'match_global_1', global: true, cloud: true, status: 'live',
      globalKey: 'K'.repeat(22), globalOrganizer: 'ABCDE23456', cloudShareToken: 'A'.repeat(22), liveSecret: 'L'.repeat(22)
    }, null)
    for (const k of ['globalKey', 'globalOrganizer', 'cloudShareToken', 'liveSecret']) expect(match).not.toHaveProperty(k)
    expect(match.global).toBe(true)
    expect(match.seed_key).toBe('match_global_1')
  })
})
