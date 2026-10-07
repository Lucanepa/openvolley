import { describe, it, expect, vi } from 'vitest'
import { createActivityFileSink, planLogPrune, activityLine, activityFileName } from '../fileSink'

describe('activity log files', () => {
  it('desktop: lines go to activity_append in batches, flushed after 2 s or 50 lines', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn(async () => 1)
    const sink = await createActivityFileSink({ platform: 'tauri', win: { __TAURI_INTERNALS__: { invoke } } })
    sink.add([{ lid: 1, uid: 'a', kind: 'app.start', synced: 0, data: {} }])
    expect(invoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(invoke).toHaveBeenCalledWith('activity_append', { lines: ['{"uid":"a","kind":"app.start","data":{}}'] })
    sink.add(Array.from({ length: 50 }, (_, i) => ({ uid: String(i), kind: 'event.add' })))
    await sink.flush()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[1][1].lines).toHaveLength(50)
    expect(sink.canOpenFolder).toBe(true)
    await sink.openFolder()
    expect(invoke).toHaveBeenLastCalledWith('activity_open_dir', undefined)
    vi.useRealTimers()
  })

  it('Android: appends to Documents/OpenVolley/logs/activity-<day>.jsonl and prunes old files', async () => {
    const calls = []
    const Filesystem = {
      mkdir: async () => {},
      stat: async () => ({}),
      appendFile: async (o) => { calls.push(['append', o.path, o.directory, o.data]) },
      writeFile: async () => {},
      readdir: async () => ({ files: [{ name: 'activity-2026-01-01.jsonl', size: 10 }, ...Array.from({ length: 30 }, (_, i) => ({ name: `activity-2026-09-${String(i + 1).padStart(2, '0')}.jsonl`, size: 10 }))] }),
      deleteFile: async (o) => { calls.push(['delete', o.path]) }
    }
    const sink = await createActivityFileSink({ platform: 'capacitor', load: async () => ({ Filesystem, Directory: { Documents: 'DOCUMENTS' }, Encoding: { UTF8: 'utf8' } }) })
    sink.add([{ uid: 'a', kind: 'app.start' }])
    await sink.flush()
    expect(calls[0]).toEqual(['append', `OpenVolley/logs/${activityFileName()}`, 'DOCUMENTS', '{"uid":"a","kind":"app.start"}\n'])
    expect(calls.filter(c => c[0] === 'delete').map(c => c[1])).toEqual(['OpenVolley/logs/activity-2026-01-01.jsonl'])
    expect(sink.canOpenFolder).toBe(false)
  })

  it('a browser has no log files', async () => {
    expect(await createActivityFileSink({ platform: 'web' })).toBeNull()
  })

  it('prune plan: newest kept, by count and size, other files untouched', () => {
    const files = [
      { name: 'activity-2026-10-05.jsonl', size: 100 }, { name: 'activity-2026-10-04.jsonl', size: 100 },
      { name: 'activity-2026-10-03.jsonl', size: 100 }, { name: 'desktop.log', size: 1e9 }
    ]
    expect(planLogPrune(files, { keepFiles: 2 })).toEqual(['activity-2026-10-03.jsonl'])
    expect(planLogPrune(files, { keepBytes: 150 })).toEqual(['activity-2026-10-04.jsonl', 'activity-2026-10-03.jsonl'])
    expect(planLogPrune(files, { keepBytes: 1 })).toEqual(['activity-2026-10-04.jsonl', 'activity-2026-10-03.jsonl'])
    expect(activityLine({ lid: 3, synced: 1, uid: 'x' })).toBe('{"uid":"x"}')
  })
})
