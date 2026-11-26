// scripts/import-help-videos.mjs: the recorder's manifest also lists the
// website's "Your first match" (first-match), which is no help section. It is
// skipped with one line; the help sections' videos are imported as before
// (owner follow-up 26.11.2026: the 17-entry manifest stopped the import).
import { describe, it, expect, vi } from 'vitest'
import { readManifest, helpVideosSource } from '../import-help-videos.mjs'

const entry = (id, over = {}) => ({
  id,
  title: { en: `${id} en`, de: `${id} de`, fr: `${id} fr`, it: `${id} it` },
  durationSec: 42.04,
  file: `${id}.mp4`,
  poster: `${id}.jpg`,
  tracks: { en: `${id}.en.vtt`, de: `${id}.de.vtt`, fr: `${id}.fr.vtt`, it: `${id}.it.vtt` },
  appVersion: '26.11.7',
  recordedAt: '2026-11-26T18:12:27.279Z',
  ...over
})

describe('import-help-videos: readManifest', () => {
  it('skips an entry that is no help section, one line each, and imports the help sections', () => {
    const log = vi.fn()
    const manifest = [entry('home'), entry('first-match', { chapters: { en: 'first-match.chapters.en.vtt' } }), entry('scoring'), entry('nonsense')]
    const { byId, problems, skipped } = readManifest(manifest, { log, sizeOf: () => ({ width: 1280, height: 872 }) })
    expect(problems).toEqual([])
    expect(skipped).toEqual(['first-match', 'nonsense'])
    expect(log.mock.calls).toEqual([['first-match: not a help section, skipped'], ['nonsense: not a help section, skipped']])
    expect([...byId.keys()]).toEqual(['home', 'scoring'])
    expect(byId.get('home')).toMatchObject({ durationSec: 42, size: { width: 1280, height: 872 }, languages: ['en', 'de', 'fr', 'it'] })

    const src = helpVideosSource(byId)
    expect(src).toContain("  home: { title: { en: 'home en'")
    expect(src).toContain('  scoring: {')
    expect(src).not.toContain('first-match')
    expect(src).toContain('// (OpenVolley 26.11.7, 26.11.2026)')
  })

  it('still stops on a broken help section entry, and on a manifest without any', () => {
    const log = vi.fn()
    expect(readManifest([entry('home', { file: 'Home.mp4' })], { log }).problems).toEqual(['home: file Home.mp4, not home.mp4'])
    expect(readManifest([entry('first-match')], { log }).problems).toEqual(['no help section has a video in the manifest'])
    expect(readManifest([entry('home'), entry('home')], { log }).problems).toEqual(['home: listed twice'])
  })
})
