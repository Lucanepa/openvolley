/**
 * Realtime client — REALTIME ONLY, no Supabase any more.
 *
 * Every database, storage and auth call goes through the backend (apiClient.js).
 * This module keeps its old name and export so the realtime call sites
 * (`supabase.channel(...).on('postgres_changes', ...).subscribe()`,
 * `supabase.removeChannel(ch)`) work unchanged: `supabase` is the
 * relayRealtime shim, which speaks the same channel API over one `?purpose=live`
 * WebSocket to the OpenVolley backend (lib/realtimeHub.js). No VITE_SUPABASE_*
 * variables and no keys are needed.
 *
 * It is never null. Against a backend without live support (the LAN relays)
 * the shim reports CHANNEL_ERROR once and the callers' relay paths take over.
 */
export { relayRealtime as supabase } from './relayRealtime'
