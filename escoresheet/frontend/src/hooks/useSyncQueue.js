import { useEffect, useCallback, useRef } from 'react'
import { db } from '../db/db'
import { supabase } from '../lib/supabaseClient'

export function useSyncQueue() {
  const busy = useRef(false)

  const flush = useCallback(async () => {
    if (busy.current) return
    if (!supabase) return // offline-only mode or no env
    busy.current = true
    try {
      const queued = await db.sync_queue.where('status').equals('queued').toArray()
      for (const job of queued) {
        if (job.resource === 'event' && job.action === 'insert') {
          const { error } = await supabase.from('events').insert(job.payload)
          if (error) {
            await db.sync_queue.update(job.id, { status: 'error' })
          } else {
            await db.sync_queue.update(job.id, { status: 'sent' })
          }
        }
        // extend with other resources as needed
      }
    } finally {
      busy.current = false
    }
  }, [])

  useEffect(() => {
    const onOnline = () => flush()
    window.addEventListener('online', onOnline)
    flush()
    return () => window.removeEventListener('online', onOnline)
  }, [flush])

  return { flush }
}


