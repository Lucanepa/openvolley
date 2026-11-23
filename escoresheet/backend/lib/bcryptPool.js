/**
 * lib/bcryptPool.js — bcrypt in worker threads, off the main event loop
 * (audit 2611 SEC-03).
 *
 * bcryptjs is pure JS: a cost-10 compare is about 60-150 ms of CPU. On the
 * main thread it shares the event loop with the live-scoring relay and every
 * other request, so a flood of sign-ins slowed everything and the sign-in gate
 * had to stay at 2. Here each compare / hash runs with bcryptjs's sync API in
 * a worker thread; the main thread only posts a message and awaits the answer.
 * The library is the same bcryptjs the main thread loads, so hashes and
 * results are byte for byte the same.
 *
 * createBcryptPool({ size, logger, timeoutMs }) -> pool | null
 *   pool.compare(password, hash) -> Promise<boolean>
 *   pool.hash(password, cost)    -> Promise<string>
 *   pool.size                    the number of worker threads (started on first use)
 *   pool.stats()                 -> { size, workers, busy, queued, fallbacks, broken }
 *   pool.close()                 -> Promise (terminates the threads)
 * null when bcryptjs cannot be found on disk for a worker (the bundled
 * standalone hall server has no node_modules): the caller keeps bcryptjs on
 * the main thread, as before.
 *
 * A worker that dies, cannot start or does not answer within timeoutMs never
 * fails a sign-in: that job runs on the main thread instead (bcryptjs's async
 * API, as before), and the thread is replaced on the next job. After
 * MAX_SPAWN_FAILURES starts in a row that fail, the pool gives up and every job
 * runs on the main thread (logged once). An error bcryptjs itself throws (a bad
 * argument) rejects the job, as bcryptjs's own async API does.
 *
 * Idle threads are unref()'d: they never keep the process (or a test) alive.
 * Nothing runs at import time.
 */

import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import bcryptjs from 'bcryptjs'

const MAX_SPAWN_FAILURES = 3
const MAX_POOL_SIZE = 16

/** The worker's code: CommonJS, eval'd, loads bcryptjs by its absolute path. */
function workerSource (bcryptPath) {
  return `'use strict'
const { parentPort } = require('node:worker_threads')
const bcrypt = require(${JSON.stringify(bcryptPath)})
parentPort.on('message', (m) => {
  try {
    const value = m.op === 'compare' ? bcrypt.compareSync(m.a, m.b) : bcrypt.hashSync(m.a, m.b)
    parentPort.postMessage({ id: m.id, value })
  } catch (err) {
    parentPort.postMessage({ id: m.id, error: String((err && err.message) || err) })
  }
})`
}

/** The file of bcryptjs for require(), or null (a bundle without node_modules). */
function resolveBcryptjs () {
  try {
    return createRequire(import.meta.url).resolve('bcryptjs')
  } catch {
    return null
  }
}

export function createBcryptPool ({ size = 1, logger = console, timeoutMs = 20_000, bcryptPath = resolveBcryptjs(), workerFactory = null } = {}) {
  const n = Math.max(1, Math.min(MAX_POOL_SIZE, Math.floor(Number(size) || 1)))
  if (!bcryptPath && !workerFactory) return null
  const source = bcryptPath ? workerSource(bcryptPath) : null
  const spawnWorker = workerFactory || (() => new Worker(source, {
    eval: true,
    name: 'ov-bcrypt',
    // bcrypt needs a few kilobytes; keep a runaway worker from growing
    resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 }
  }))
  const slots = [] // { worker, job } (job null when idle)
  const queue = [] // jobs waiting for a thread
  let seq = 0
  let spawnFailures = 0
  let broken = false
  let fallbacks = 0
  let closed = false

  function inProcess (job) {
    fallbacks++
    const p = job.op === 'compare' ? bcryptjs.compare(job.a, job.b) : bcryptjs.hash(job.a, job.b)
    p.then(job.resolve, job.reject)
  }

  function giveUp (why) {
    if (broken) return
    broken = true
    logger.error?.(`[auth] bcrypt worker threads unavailable (${why}): bcrypt runs on the main thread`)
  }

  function finish (slot, msg) {
    const job = slot.job
    if (!job) return
    slot.job = null
    clearTimeout(job.timer)
    slot.worker.unref?.()
    if (msg.error !== undefined) job.reject(new Error(msg.error))
    else job.resolve(msg.value)
    next()
  }

  function drop (slot, why) {
    if (slot.dead) return
    slot.dead = true
    const i = slots.indexOf(slot)
    if (i !== -1) slots.splice(i, 1)
    const job = slot.job
    slot.job = null
    if (job) {
      clearTimeout(job.timer)
      // never fail a sign-in for a thread: this job runs here instead
      inProcess(job)
    }
    if (!slot.answered) {
      spawnFailures++
      if (spawnFailures >= MAX_SPAWN_FAILURES) giveUp(why)
    }
    slot.worker.terminate?.().catch?.(() => {})
    next()
  }

  function spawn () {
    let worker
    try {
      worker = spawnWorker()
    } catch (err) {
      spawnFailures++
      if (spawnFailures >= MAX_SPAWN_FAILURES) giveUp(err?.message || 'start failed')
      return null
    }
    const slot = { worker, job: null, answered: false, dead: false }
    worker.unref?.()
    worker.on('message', (msg) => {
      if (!slot.answered) { slot.answered = true; spawnFailures = 0 }
      if (slot.job && msg && msg.id === slot.job.id) finish(slot, msg)
    })
    worker.on('error', (err) => drop(slot, err?.message || 'worker error'))
    worker.on('exit', (code) => drop(slot, `worker exited (${code})`))
    slots.push(slot)
    return slot
  }

  function dispatch (slot, job) {
    slot.job = job
    slot.worker.ref?.() // a job in flight keeps the process alive, as bcryptjs's own timers did
    job.timer = setTimeout(() => {
      if (slot.job !== job) return
      logger.warn?.(`[auth] a bcrypt worker did not answer within ${timeoutMs} ms; replacing it`)
      drop(slot, 'timeout')
    }, timeoutMs)
    job.timer.unref?.()
    try {
      slot.worker.postMessage({ id: job.id, op: job.op, a: job.a, b: job.b })
    } catch (err) {
      drop(slot, err?.message || 'post failed')
    }
  }

  function next () {
    while (queue.length) {
      if (broken || closed) { inProcess(queue.shift()); continue }
      let slot = slots.find((s) => !s.job)
      if (!slot && slots.length < n) slot = spawn()
      if (!slot) {
        if (broken) continue // spawn gave up: the loop runs the rest here
        if (!slots.length) { inProcess(queue.shift()); continue } // could not start one now
        return // every thread is busy: the job waits for one
      }
      dispatch(slot, queue.shift())
    }
  }

  function run (op, a, b) {
    return new Promise((resolve, reject) => {
      const job = { id: ++seq, op, a, b, resolve, reject, timer: null }
      if (broken || closed) return inProcess(job)
      queue.push(job)
      next()
    })
  }

  return {
    size: n,
    compare: (password, hash) => run('compare', password, hash),
    hash: (password, cost) => run('hash', password, cost),
    stats: () => ({ size: n, workers: slots.length, busy: slots.filter((s) => s.job).length, queued: queue.length, fallbacks, broken }),
    async close () {
      closed = true
      const all = slots.splice(0)
      for (const s of all) {
        s.dead = true
        if (s.job) { clearTimeout(s.job.timer); inProcess(s.job); s.job = null }
      }
      await Promise.allSettled(all.map((s) => s.worker.terminate?.()))
    }
  }
}
