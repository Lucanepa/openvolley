/**
 * One job at a time, at most `max` waiting (field-spec 17.19): a 2-CPU / 4 GB
 * host never runs two Chromium pages at once, and a burst of approvals waits
 * its turn instead of stacking up pages. A job past the limit is refused at
 * once (the backend keeps the device's raster PDF and tries later).
 */
export class QueueFull extends Error {
  constructor () { super('render queue full'); this.code = 'OV_RENDER_BUSY' }
}

export function createQueue ({ max = 8 } = {}) {
  let tail = Promise.resolve()
  let waiting = 0
  let running = 0
  function run (job) {
    if (waiting >= max) return Promise.reject(new QueueFull())
    waiting++
    const p = tail.then(async () => {
      waiting--
      running++
      try {
        return await job()
      } finally {
        running--
      }
    })
    tail = p.catch(() => {})
    return p
  }
  return { run, stats: () => ({ waiting, running }) }
}
