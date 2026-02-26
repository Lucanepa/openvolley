/**
 * Optional Backend Server for eScoresheet
 * Provides WebSocket relay for local network connections
 * This is OPTIONAL - the app works fully offline without this server
 *
 * Use cases:
 * 1. Local network: Scoreboard ↔ Referee/Bench sync (no internet needed)
 * 2. Cloud relay: Multiple locations (requires internet)
 *

 * Or run locally for local network only
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import nodemailer from 'nodemailer'
import ical from 'node-ical'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync, statSync } from 'fs'
import { join, extname } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import QRCode from 'qrcode'

const PORT = process.env.PORT || 8080

// --- Supabase admin client (server-side only, never exposed to frontend) ---
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null
if (SUPABASE_URL) console.log('[Supabase] Admin client:', supabaseAdmin ? 'CONFIGURED' : 'NOT CONFIGURED')

// Allowed tables/buckets for proxy endpoints
const ALLOWED_TABLES = ['matches', 'sets', 'events', 'match_live_state', 'profiles', 'referee_database', 'user_matches', 'svrz_games', 'beach_competition_matches', 'teams']
const ALLOWED_BUCKETS = ['scoresheets', 'backup']
const ALLOWED_RPC = ['delete_user']
const DB_RATE_LIMIT_MAX = 200
const AUTH_RATE_LIMIT_MAX = 10
const EMAIL_RATE_LIMIT_MAX = 3
const ICAL_RATE_LIMIT_MAX = 10
const STORAGE_RATE_LIMIT_MAX = 200

// Per-table column whitelist for filter/order operations
const ALLOWED_COLUMNS = {
  matches: ['id', 'external_id', 'user_id', 'sport_type', 'game_n', 'game_pin', 'scheduled_at', 'status', 'created_at', 'match_id', 'last_name', 'first_name', 'match_info->>competition_name'],
  sets: ['id', 'external_id', 'match_id', 'set_number', 'sport_type', 'user_id', 'created_at', 'last_name', 'first_name'],
  events: ['id', 'external_id', 'match_id', 'game_n', 'game_pin', 'sport_type', 'status'],
  match_live_state: ['id', 'external_id', 'match_id', 'sport_type', 'status', 'scheduled_at'],
  profiles: ['id', 'user_id'],
  referee_database: ['id', 'sport_type', 'last_name', 'first_name'],
  user_matches: ['id', 'user_id', 'match_id', 'external_id'],
  svrz_games: ['id', 'gender', 'league', 'datetime'],
  beach_competition_matches: ['id', 'external_id', 'scheduled_at', 'status', 'competition_id'],
  teams: ['id']
}


// Option 1: Resend API (recommended - uses HTTPS, never blocked)
// RESEND_API_KEY
// Option 2: SMTP (may be blocked by some cloud providers)
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, CONTACT_EMAIL
if (process.env.RESEND_API_KEY || process.env.SMTP_HOST) {
  console.log('[Email Config] RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_HOST:', process.env.SMTP_HOST ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_PORT:', process.env.SMTP_PORT || 'NOT SET')
  console.log('[Email Config] SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET')
  console.log('[Email Config] SMTP_PASS:', process.env.SMTP_PASS ? 'SET' : 'NOT SET')
}

// Resend email helper (uses HTTPS - works on all cloud platforms)
async function sendViaResend(to, subject, text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000) // 10s timeout
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'eScoresheet <escoresheet@openvolley.app>',
        to: [to],
        subject: subject,
        text: text
      }),
      signal: controller.signal
    })
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data.message || 'Resend API error')
    }
    return data
  } finally {
    clearTimeout(timeout)
  }
}
const emailTransporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  connectionTimeout: 10000, // 10 seconds max to connect
  greetingTimeout: 10000,
  socketTimeout: 15000,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null
const IS_CLOUD = process.env.IS_CLOUD
const IS_LOCAL = !SUPABASE_URL || process.argv.includes('--local')

// --- Static file serving for standalone/local mode ---
const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')
const STATIC_DIR = join(__dirname, 'public')
const HAS_STATIC = existsSync(STATIC_DIR)

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp'
}

if (HAS_STATIC) {
  console.log('[Static] Serving frontend files from:', STATIC_DIR)
} else {
  console.log('[Static] No public/ directory found — static file serving disabled')
}

// --- Local IP detection ---
function getLocalIPs() {
  const ips = []
  const interfaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ name, address: addr.address })
      }
    }
  }
  return ips
}

// In-memory storage for active matches
// NOTE: This resets on server restart - Supabase is the source of truth for persistence
const activeMatches = new Map()
const connections = new Map()
const rooms = new Map() // Match rooms for isolated communication

// --- Capacity limits ---
const MAX_ROOMS = 500
const MAX_CONNECTIONS = 2000
const MAX_CONNECTIONS_PER_IP = 50
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

// --- Input validation constants ---
const VALID_ROLES = ['scoreboard', 'referee', 'bench', 'subscriber', 'livescore']
const VALID_TEAMS = ['home', 'away']
const ROLES_REQUIRING_PIN = ['referee', 'bench']

// --- Security helpers ---
function isValidStoragePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\\')) return false
  return true
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string' || email.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function isValidPin(pin) {
  return /^\d{6}$/.test(String(pin).trim())
}

// --- Client IP extraction (X-Forwarded-For hardening) ---
function getClientIp(req) {
  // In cloud mode behind Cloudflare, use CF-Connecting-IP (unspoofable by clients)
  if (IS_CLOUD) {
    const cfIp = req.headers['cf-connecting-ip']
    if (cfIp) return cfIp.trim()
  }
  // In local mode, use socket address directly (no reverse proxy on LAN)
  if (IS_LOCAL) {
    const addr = req.socket.remoteAddress || 'unknown'
    return addr.replace('::ffff:', '')
  }
  // Fallback: X-Forwarded-For leftmost entry (per spec)
  const xff = req.headers['x-forwarded-for']
  if (xff) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length > 0) return parts[0]
  }
  const addr = req.socket.remoteAddress || 'unknown'
  return addr.replace('::ffff:', '')
}

// --- Rate limiting (per-category isolation) ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000
const RATE_LIMIT_MAX_REQUESTS = 10
const CONTACT_RATE_LIMIT_MAX = 3
// One Map per category so counters don't interfere across endpoint types
const rateLimitMaps = {
  default: new Map(),   // validate-pin, etc.
  contact: new Map(),   // /api/contact
  email: new Map(),     // /api/match/send-info
  auth: new Map(),      // /api/auth/*, /api/verify-reopen-password
  ical: new Map(),      // /api/official-matches
  db: new Map(),        // /api/db
  storage: new Map()    // /api/storage/*, /api/db/rpc
}

function isRateLimited(ip, maxRequests = RATE_LIMIT_MAX_REQUESTS, category = 'default') {
  const map = rateLimitMaps[category] || rateLimitMaps.default
  const now = Date.now()
  const entry = map.get(ip)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > maxRequests
}

setInterval(() => {
  const now = Date.now()
  for (const map of Object.values(rateLimitMaps)) {
    for (const [ip, entry] of map.entries()) {
      if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
        map.delete(ip)
      }
    }
  }
}, 5 * 60 * 1000)

// --- Log sanitizer (prevent log injection via newlines/control chars) ---
function sanitizeLog(str) {
  if (typeof str !== 'string') return String(str)
  return str.replace(/[\r\n\t]/g, ' ').substring(0, 200)
}

// --- WebSocket per-client rate limiting ---
const WS_RATE_LIMIT_MAX = 120 // messages per window
const WS_RATE_LIMIT_WINDOW_MS = 60 * 1000
const wsRateLimitMap = new Map()

function isWsRateLimited(clientId) {
  const now = Date.now()
  const entry = wsRateLimitMap.get(clientId)

  if (!entry || now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS) {
    wsRateLimitMap.set(clientId, { count: 1, windowStart: now })
    return false
  }

  entry.count++
  return entry.count > WS_RATE_LIMIT_MAX
}

// --- TTL cleanup for stale rooms, matches, and WS rate limit entries ---
setInterval(() => {
  const now = Date.now()

  // Clean up rooms inactive for >24h
  for (const [matchId, room] of rooms.entries()) {
    if (room.clients.size === 0 && now - (room.lastActivity || 0) > ROOM_TTL_MS) {
      rooms.delete(matchId)
      activeMatches.delete(matchId)
      console.log(`🧹 TTL cleanup: removed stale room ${matchId}`)
    }
  }

  // Clean up WS rate limit entries
  for (const [id, entry] of wsRateLimitMap.entries()) {
    if (now - entry.windowStart > WS_RATE_LIMIT_WINDOW_MS * 2) {
      wsRateLimitMap.delete(id)
    }
  }
}, 15 * 60 * 1000) // Every 15 minutes

const MAX_BODY_SIZE = 1024 * 1024 // 1MB
const MAX_MATCH_BODY_SIZE = 5 * 1024 * 1024 // 5MB for match data with email

// iCal feed configuration for Swiss VolleyManager
const ICAL_FEEDS = {
  SV: {
    national: true,
    leagues: {
      '1LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/ae02358a6a06486238124a59f1449e8a82606f70', gender: 'women' },
      '1LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/c0bef7b2b63c41841fd9857fb641a0384f126b50', gender: 'men' }
    }
  },
  SVRZ: {
    national: false,
    leagues: {
      '2LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/845ac49df3bd9411aa3094ec5fb58c934c3351a3', gender: 'women' },
      '2LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/10d3dbb456d62789fbb5f324d6b2977fa31a2142', gender: 'men' },
      '3LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/64059c25792dea0dc30d5d9f63d17a5a8b4030a4', gender: 'women' },
      '3LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/06dbdddc56b1792558dcc02e00db9d5eb35197d9', gender: 'men' },
      '4LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/fdff38685c5166350b903f1238e7510185f8bbcc', gender: 'women' },
      '4LM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/7fe2162c7ce91df5ab10dc3466fb6252315b25a4', gender: 'men' },
      '5LD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/52e4678e8e476857aeb96b45c8c953fa4c1da1d8', gender: 'women' },
      'U23D-1': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/ae87559b2b0ccb924e5f4c8a12299fdbd2946623', gender: 'women', level: 'U23' },
      'U23D-2': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/2876c11fa736b4b88eb1f3038a37e075563e515e', gender: 'women', level: 'U23' },
      'U23D-3': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/82e03b16627e47d941e2d95a3d5e8a0d1bcc8249', gender: 'women', level: 'U23' },
      'U23M': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/1bb02aaf2b8acad94d5d440c6ce44fb6fa4eb3c5', gender: 'men', level: 'U23' },
      'ZCD': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/e0567aa2b79236b9dc5bf69b575e537beb670ec4', gender: 'women', cup: true },
      'ZCM': { url: 'https://volleymanager.volleyball.ch/iCal/schedule/749f56450d476e450c5391106b95d151a0b53ee9', gender: 'men', cup: true }
    }
  }
}

// Cache for iCal data (5 minute TTL)
const icalCache = new Map()
const ICAL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Helper functions for iCal parsing
function extractGameNumber(uid) {
  const match = uid?.match(/game-(\d+)/)
  return match ? match[1] : ''
}

function extractCity(location) {
  if (!location) return ''
  // Match pattern: "..., POSTCODE CITY" where POSTCODE is 4 digits for Switzerland
  const match = location.match(/,\s*(\d{4})\s+(.+)$/)
  if (match) {
    return match[2].trim()
  }
  // Fallback: return everything after last comma
  const parts = location.split(',')
  if (parts.length > 1) {
    return parts[parts.length - 1].trim()
  }
  return location
}

function parseIcalDescription(description) {
  if (!description) return {}
  const data = {}
  const lines = description.split(/\\n|\n/)

  for (const line of lines) {
    if (line.includes('Risultato:')) {
      data.result = line.replace(/.*Risultato:\s*/, '').trim()
    }
    if (line.includes('Lega:')) {
      // Parse: "#6655 | 3L | ♀"
      const legaMatch = line.match(/#(\d+)\s*\|\s*([^|]+)\s*\|\s*([♂♀])/)
      if (legaMatch) {
        data.leagueId = legaMatch[1]
        data.leagueName = legaMatch[2].trim()
        data.genderSymbol = legaMatch[3]
      }
    }
    if (line.includes('Palestra:')) {
      data.venue = line.replace(/.*Palestra:\s*/, '').trim()
    }
    if (line.includes('Indirizzo:')) {
      data.address = line.replace(/.*Indirizzo:\s*/, '').trim()
    }
  }

  return data
}

async function fetchAndParseIcal(feedUrl, federation, leagueCode, leagueConfig) {
  // Check cache first
  const cacheKey = `${federation}-${leagueCode}`
  const cached = icalCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < ICAL_CACHE_TTL) {
    console.log(`[iCal] Using cached data for ${cacheKey}`)
    return cached.matches
  }

  console.log(`[iCal] Fetching fresh data for ${cacheKey} from ${feedUrl}`)

  try {
    const events = await Promise.race([
      ical.fromURL(feedUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('iCal fetch timeout')), 15000))
    ])
    const now = new Date()
    now.setHours(0, 0, 0, 0) // Start of today

    const matches = []

    for (const [key, event] of Object.entries(events)) {
      if (event.type !== 'VEVENT') continue

      // Skip past events
      const startDate = event.start
      if (!startDate || startDate < now) continue

      // Parse SUMMARY for teams: "Home Team - Away Team (League)"
      const summaryMatch = event.summary?.match(/^(.+?)\s*-\s*(.+?)\s*\(([^)]+)\)$/)
      const home = summaryMatch?.[1]?.trim() || ''
      const away = summaryMatch?.[2]?.trim() || ''
      const leagueInSummary = summaryMatch?.[3]?.trim() || ''

      // Parse DESCRIPTION for structured data
      const parsedDesc = parseIcalDescription(event.description)

      // Determine match type
      const isCup = leagueConfig.cup === true || leagueCode.startsWith('ZC')
      const isNational = ICAL_FEEDS[federation]?.national === true
      const isU23 = leagueConfig.level === 'U23' || leagueCode.includes('U23')

      matches.push({
        gameN: extractGameNumber(event.uid),
        dtstart: startDate.toISOString(),
        home,
        away,
        league: parsedDesc.leagueName || leagueInSummary || leagueCode,
        venue: parsedDesc.venue || '',
        city: extractCity(event.location),
        address: event.location || '',
        type1: isCup ? 'cup' : 'championship',
        type2: leagueConfig.gender,
        type3: isU23 ? 'U23' : 'senior',
        championshipType: isNational ? 'national' : 'regional',
        result: parsedDesc.result || '-'
      })
    }

    // Sort by date ascending
    matches.sort((a, b) => new Date(a.dtstart) - new Date(b.dtstart))

    // Cache the results
    icalCache.set(cacheKey, {
      matches,
      timestamp: Date.now()
    })

    console.log(`[iCal] Parsed ${matches.length} upcoming matches for ${cacheKey}`)
    return matches
  } catch (err) {
    console.error(`[iCal] Error fetching ${feedUrl}:`, err.message)
    throw err
  }
}

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://openvolley.app',
  'https://app.openvolley.app',
  'https://referee.openvolley.app',
  'https://bench.openvolley.app',
  'https://livescore.openvolley.app',
  'https://roster.openvolley.app',
  // Local development
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000'
]

function getCorsOrigin(req) {
  const origin = req.headers.origin
  console.log(`[CORS] Request from origin: ${origin}, IS_CLOUD: ${IS_CLOUD}`)
  // In local mode, reflect the requesting origin for LAN access.
  // Intentionally permissive — local server is on a trusted network.
  if (!IS_CLOUD) return origin || '*'
  // In production, check against allowed list
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    console.log(`[CORS] Origin ${origin} is in ALLOWED_ORIGINS`)
    return origin
  }
  // Allow any openvolley.app subdomain
  if (origin && origin.match(/^https:\/\/[a-z0-9-]+\.openvolley\.app$/)) {
    console.log(`[CORS] Origin ${origin} matches openvolley.app subdomain pattern`)
    return origin
  }
  console.log(`[CORS] Origin ${origin} not recognized, using default: ${ALLOWED_ORIGINS[0]}`)
  return ALLOWED_ORIGINS[0] // Default to main domain
}

// Create HTTP server
const server = createServer((req, res) => {
  // Enable CORS with proper origin handling
  const corsOrigin = getCorsOrigin(req)
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (IS_CLOUD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  // Content Security Policy — cloud mode only (local mode needs permissive access for LAN IPs)
  if (IS_CLOUD) {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' wss://*.openvolley.app https://*.supabase.co",
      "font-src 'self'",
      "frame-ancestors 'none'"
    ].join('; '))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'healthy',
      mode: IS_CLOUD ? 'cloud' : 'local',
      uptime: process.uptime(),
      connections: connections.size,
      activeRooms: rooms.size
    }))
    return
  }

  // Server status
  if (url.pathname === '/api/server/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'online',
      mode: IS_CLOUD ? 'cloud' : 'local',
      wsPort: PORT,
      connections: connections.size,
      matches: activeMatches.size,
      rooms: rooms.size,
      uptime: process.uptime()
    }))
    return
  }

  // Validate PIN for referee/bench access
  if (url.pathname === '/api/match/validate-pin' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, RATE_LIMIT_MAX_REQUESTS, 'default')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many attempts. Please wait a minute before trying again.' }))
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > MAX_BODY_SIZE) {
        req.destroy()
        return
      }
    })
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }))
          return
        }

        const { pin, type = 'referee' } = JSON.parse(body)

        if (!isValidPin(pin)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid PIN format' }))
          return
        }

        const pinStr = String(pin).trim()

        // Search active matches for matching PIN
        let matchFound = null
        for (const [matchId, matchData] of activeMatches.entries()) {
          const match = matchData.match || matchData
          if (!match) continue

          let matchPin = null
          if (type === 'referee') {
            matchPin = match.refereePin
          } else if (type === 'homeTeam') {
            matchPin = match.homeTeamPin
          } else if (type === 'awayTeam') {
            matchPin = match.awayTeamPin
          }

          if (matchPin && String(matchPin).trim() === pinStr) {
            let connectionEnabled = true
            if (type === 'referee') {
              connectionEnabled = match.refereeConnectionEnabled === true
            } else if (type === 'homeTeam') {
              connectionEnabled = match.homeTeamConnectionEnabled === true
            } else if (type === 'awayTeam') {
              connectionEnabled = match.awayTeamConnectionEnabled === true
            }

            if (connectionEnabled && match.status !== 'final') {
              matchFound = { ...match, id: matchId }
              break
            }
          }
        }

        if (matchFound) {
          console.log(`[API] PIN validated for ${type}: match ${matchFound.id}`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true, match: matchFound }))
        } else {
          console.log(`[API] PIN validation failed for ${type}`)
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.'
          }))
        }
      } catch (err) {
        console.error('[API] Error validating PIN:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid request body' }))
      }
    })
    return
  }

  // List active matches (ephemeral - just for current session)
  // Only return matches where refereeConnectionEnabled is true
  if (url.pathname === '/api/match/list') {
    try {
      const allMatches = Array.from(activeMatches.values())
      const filteredMatches = allMatches.filter(m => {
        // Check if refereeConnectionEnabled is explicitly true
        return m.match?.refereeConnectionEnabled === true
      })
      console.log(`[API] /api/match/list - Total: ${allMatches.length}, Referee enabled: ${filteredMatches.length}`)
      allMatches.forEach(m => {
        console.log(`  - Game #${m.gameNumber || m.matchId}: refereeConnectionEnabled=${m.match?.refereeConnectionEnabled}`)
      })

      // Format response to match dev server (flat structure)
      const formattedMatches = filteredMatches.map(m => {
        // Format scheduled date/time
        let dateTime = 'TBD'
        if (m.match?.scheduledAt) {
          try {
            const scheduledDate = new Date(m.match.scheduledAt)
            const dateStr = scheduledDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            const timeStr = scheduledDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
            dateTime = `${dateStr} ${timeStr}`
          } catch (e) {
            dateTime = 'TBD'
          }
        }

        // Get team names - handle both object format {name: 'Team'} and string format 'Team'
        const homeTeamName = typeof m.homeTeam === 'object' ? m.homeTeam?.name : m.homeTeam
        const awayTeamName = typeof m.awayTeam === 'object' ? m.awayTeam?.name : m.awayTeam

        return {
          id: m.matchId,
          gameNumber: m.gameNumber || m.match?.gameNumber || m.match?.game_n || m.matchId,
          homeTeam: homeTeamName || 'Home',
          awayTeam: awayTeamName || 'Away',
          scheduledAt: m.match?.scheduledAt,
          dateTime,
          status: m.match?.status || 'scheduled',
          refereeConnectionEnabled: m.match?.refereeConnectionEnabled === true
        }
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        matches: formattedMatches
      }))
    } catch (error) {
      console.error('[API] Error in /api/match/list:', error)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Internal server error',
        matches: []
      }))
    }
    return
  }

  // Get match data by ID
  if (url.pathname.startsWith('/api/match/') &&
      url.pathname !== '/api/match/list' &&
      url.pathname !== '/api/match/validate-pin' &&
      url.pathname !== '/api/match/by-game-number' &&
      req.method === 'GET') {
    const matchId = url.pathname.replace('/api/match/', '')

    if (!matchId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: 'Match ID required' }))
      return
    }

    // Try to find match in activeMatches
    let matchData = activeMatches.get(matchId)

    // Also try with/without leading zeros or string conversion
    if (!matchData) {
      matchData = activeMatches.get(String(matchId))
    }
    if (!matchData) {
      matchData = activeMatches.get(Number(matchId))
    }

    if (matchData) {
      console.log(`[API] /api/match/${matchId} - Found match`)
      // Ensure team objects have the correct format
      const homeTeam = typeof matchData.homeTeam === 'object' ? matchData.homeTeam : { name: matchData.homeTeam || 'Home' }
      const awayTeam = typeof matchData.awayTeam === 'object' ? matchData.awayTeam : { name: matchData.awayTeam || 'Away' }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        match: matchData.match,
        homeTeam,
        awayTeam,
        homePlayers: matchData.homePlayers || [],
        awayPlayers: matchData.awayPlayers || [],
        sets: matchData.sets || [],
        events: matchData.events || []
      }))
    } else {
      console.log(`[API] /api/match/${sanitizeLog(matchId)} - Match not found. Active matches: ${Array.from(activeMatches.keys()).join(', ')}`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Match not found. Make sure the main scoresheet is running and connected.'
      }))
    }
    return
  }

  // Get detailed connection info for dashboard server UI
  if (url.pathname === '/api/server/connections') {
    const matchId = url.searchParams.get('matchId')

    // Build client list (exclude WebSocket object and filter by matchId if provided)
    const clients = []
    connections.forEach((client) => {
      // Skip if matchId filter is set and client is not in that match
      if (matchId && String(client.matchId) !== String(matchId)) {
        return
      }
      // Only include dashboard clients (referee, bench) - not scoreboard
      if (client.role && client.role !== 'scoreboard') {
        clients.push({
          id: client.id,
          ip: client.ip,
          role: client.role,
          team: client.team,
          matchId: client.matchId,
          connectedAt: client.connectedAt
        })
      }
    })

    // Count by role
    const refereesCount = clients.filter(c => c.role === 'referee').length
    const benchCount = clients.filter(c => c.role === 'bench').length

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalClients: connections.size,
      dashboardClients: clients.length,
      referees: refereesCount,
      benches: benchCount,
      clients,
      matchSubscriptions: Object.fromEntries(
        Array.from(rooms.entries()).map(([matchId, room]) => [matchId, room.clients.size])
      )
    }))
    return
  }

  // Contact/Support form endpoint
  if (url.pathname === '/api/contact' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, CONTACT_RATE_LIMIT_MAX, 'contact')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ success: false, error: 'Too many requests. Please wait before submitting again.' }))
      return
    }
    // Parse multipart form data (simplified - just log for now, email via mailto fallback)
    let body = ''
    const chunks = []
    let totalSize = 0
    req.on('data', chunk => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks)
        const contentType = req.headers['content-type'] || ''

        // Extract form data
        let formData = {}
        if (contentType.includes('multipart/form-data')) {
          // Simple multipart parser for text fields only
          const boundary = contentType.split('boundary=')[1]
          if (boundary) {
            const parts = buffer.toString().split('--' + boundary)
            parts.forEach(part => {
              const nameMatch = part.match(/name="([^"]+)"/)
              if (nameMatch && !part.includes('filename=')) {
                const name = nameMatch[1]
                const valueMatch = part.split('\r\n\r\n')
                if (valueMatch[1]) {
                  formData[name] = valueMatch[1].replace(/\r\n--$/, '').trim()
                }
              }
            })
          }
        } else {
          try {
            formData = JSON.parse(buffer.toString())
          } catch {
            formData = {}
          }
        }

        // Validate email to prevent header injection
        if (formData.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email) || /[\r\n]/.test(formData.email))) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid email address' }))
          return
        }

        console.log('[Contact] Received feedback:', {
          contactType: sanitizeLog(formData.contactType),
          area: sanitizeLog(formData.area),
          supportType: sanitizeLog(formData.supportType),
          severity: sanitizeLog(formData.severity),
          email: sanitizeLog(formData.email),
          comments: sanitizeLog(formData.comments?.substring(0, 100)),
          timestamp: formData.timestamp
        })

        // Sanitize all form fields to prevent CRLF/header injection in email
        const sanitizeField = (str, maxLen = 500) =>
          typeof str === 'string' ? str.replace(/[\r\n]/g, ' ').substring(0, maxLen).trim() : String(str || '')

        // Build email content
        const contactEmail = process.env.CONTACT_EMAIL || 'volleyball@lucanepa.com'
        const typeLabels = { support: 'Support', feedback: 'Feedback', request: 'Feature Request' }
        const supportTypeLabels = { bug: 'Bug Report', help: 'Help / Question' }
        const severityLabels = {
          '1': '1 - Tool breaks completely',
          '2': '2 - Very limited functionality',
          '3': '3 - Inconvenience',
          '4': '4 - Nice-to-have'
        }

        const safeContactType = sanitizeField(formData.contactType, 50)
        const safeArea = sanitizeField(formData.area, 100)
        const safeSupportType = sanitizeField(formData.supportType, 50)
        const safeSeverity = sanitizeField(formData.severity, 10)
        const safeComments = sanitizeField(formData.comments, 5000)
        const safeUrl = sanitizeField(formData.url, 500)
        const safeUserAgent = sanitizeField(formData.userAgent, 300)

        const subject = `[eScoresheet ${(typeLabels[safeContactType] || safeContactType).toUpperCase()}] ${safeArea}${safeSupportType ? ` - ${supportTypeLabels[safeSupportType] || safeSupportType}` : ''}`

        const emailBody = `
New ${typeLabels[safeContactType] || safeContactType} from eScoresheet

Contact Type: ${typeLabels[safeContactType] || safeContactType}
Area: ${safeArea}
${safeSupportType ? `Support Type: ${supportTypeLabels[safeSupportType] || safeSupportType}\n` : ''}${safeSeverity ? `Severity: ${severityLabels[safeSeverity] || safeSeverity}\n` : ''}
From: ${formData.email}
URL: ${safeUrl || 'N/A'}
User Agent: ${safeUserAgent || 'N/A'}
Timestamp: ${formData.timestamp || new Date().toISOString()}

Comments:
${safeComments || 'No comments provided'}
`.trim()

        // Send email if configured
        if (emailTransporter) {
          try {
            // Send to contact email
            await emailTransporter.sendMail({
              from: process.env.SMTP_USER,
              to: contactEmail,
              replyTo: formData.email,
              subject: subject,
              text: emailBody
            })

            // Send confirmation copy to user
            if (formData.email) {
              const confirmationBody = `
Thank you for contacting eScoresheet support!

This is a confirmation that your message has been received. I'll review it as soon as possible and will contact you if I have any questions.

--- Your message ---
${emailBody}
---

Best regards,
Luca
eScoresheet Developer
`.trim()

              await emailTransporter.sendMail({
                from: process.env.SMTP_USER,
                to: formData.email,
                subject: `Re: ${subject} - Message Received`,
                text: confirmationBody
              })
            }

            console.log('[Contact] Emails sent successfully')
          } catch (emailErr) {
            console.error('[Contact] Failed to send email:', emailErr)
            // Continue anyway - the form data is logged
          }
        } else {
          console.log('[Contact] Email not configured (SMTP_HOST not set). Form data logged only.')
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          message: 'Feedback received. Thank you!'
        }))
      } catch (err) {
        console.error('[Contact] Error processing form:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to process feedback'
        }))
      }
    })
    return
  }

  // Send match info email
  if (url.pathname === '/api/match/send-info' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, EMAIL_RATE_LIMIT_MAX, 'email')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > MAX_MATCH_BODY_SIZE) {
        req.destroy()
        return
      }
    })
    req.on('end', async () => {
      try {
        const matchData = JSON.parse(body)

        if (!isValidEmail(matchData.email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Invalid email address' }))
          return
        }

        console.log('[Match Email] Sending match info to:', sanitizeLog(matchData.email))

        // Check if any email method is configured
        const hasResend = !!process.env.RESEND_API_KEY
        const hasSmtp = !!emailTransporter

        if (!hasResend && !hasSmtp) {
          console.log('[Match Email] ERROR: No email method configured (need RESEND_API_KEY or SMTP)')
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'Email not configured on server'
          }))
          return
        }

        // Format date and time
        const formatDate = (dateStr) => {
          if (!dateStr) return 'TBD'
          const [year, month, day] = dateStr.split('-')
          return `${day}.${month}.${year}`
        }

        const formatTime = (timeStr) => {
          if (!timeStr) return 'TBD'
          return timeStr.substring(0, 5) // HH:MM
        }

        // Build email content
        const subject = `Game ${matchData.gameN || 'N/A'} eScoresheet`

        const emailBody = `
Match Information
=================

Game Number: ${matchData.gameN || 'N/A'}
Game PIN: ${matchData.gamePin}

Teams
-----
Home: ${matchData.home || 'N/A'}${matchData.homeShortName ? ` (${matchData.homeShortName})` : ''}
Away: ${matchData.away || 'N/A'}${matchData.awayShortName ? ` (${matchData.awayShortName})` : ''}

Match Details
-------------
Date: ${formatDate(matchData.date)}
Time: ${formatTime(matchData.time)}
Venue: ${matchData.hall || 'N/A'}
City: ${matchData.city || 'N/A'}
League: ${matchData.league || 'N/A'}

---
Generated by eScoresheet
`.trim()

        // Send email - try Resend first (HTTPS), then SMTP as fallback
        if (hasResend) {
          console.log('[Match Email] Using Resend API...')
          await sendViaResend(matchData.email, subject, emailBody)
        } else {
          console.log('[Match Email] Using SMTP...')
          await emailTransporter.sendMail({
            from: process.env.SMTP_USER,
            to: matchData.email,
            subject: subject,
            text: emailBody
          })
        }

        console.log('[Match Email] Sent successfully to:', matchData.email)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          message: 'Match info sent to email'
        }))
      } catch (err) {
        console.error('[Match Email] Error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to send email'
        }))
      }
    })
    return
  }

  // Verify reopen password (server-side hash comparison)
  if (url.pathname === '/api/verify-reopen-password' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, AUTH_RATE_LIMIT_MAX, 'auth')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    const reopenHash = process.env.REOPEN_PASSWORD_HASH
    if (!reopenHash) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true })) // No password configured = always allowed
      return
    }

    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > MAX_BODY_SIZE) { req.destroy(); return }
    })
    req.on('end', async () => {
      try {
        const { password } = JSON.parse(body)
        if (!password || typeof password !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Password required' }))
          return
        }

        // Hash the input with SHA-256 and compare (timing-safe)
        const inputHash = createHash('sha256').update(password).digest('hex')
        const inputBuf = Buffer.from(inputHash, 'utf8')
        const expectedBuf = Buffer.from(reopenHash, 'utf8')

        if (inputBuf.length === expectedBuf.length && timingSafeEqual(inputBuf, expectedBuf)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: true }))
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Incorrect password' }))
        }
      } catch (err) {
        console.error('[API] Error verifying reopen password:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: 'Invalid request' }))
      }
    })
    return
  }

  // Get official matches from iCal feeds
  if (url.pathname === '/api/official-matches' && req.method === 'GET') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, ICAL_RATE_LIMIT_MAX, 'ical')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    const federation = url.searchParams.get('federation')
    const league = url.searchParams.get('league')

    // Validate federation
    if (!federation || !ICAL_FEEDS[federation]) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: 'Invalid federation. Use SV or SVRZ.'
      }))
      return
    }

    // Validate league
    const leagueConfig = ICAL_FEEDS[federation].leagues[league]
    if (!league || !leagueConfig) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: false,
        error: `Invalid league for ${federation}. Available: ${Object.keys(ICAL_FEEDS[federation].leagues).join(', ')}`
      }))
      return
    }

    // Use async IIFE since the request handler isn't async
    ;(async () => {
      try {
        const matches = await fetchAndParseIcal(leagueConfig.url, federation, league, leagueConfig)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: true,
          federation,
          league,
          matches
        }))
      } catch (err) {
        console.error('[API] Error fetching official matches:', err)
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          success: false,
          error: 'Failed to fetch matches from VolleyManager. Please try again.'
        }))
      }
    })()
    return
  }

  // Get available leagues for official matches (flat list)
  if (url.pathname === '/api/official-matches/leagues' && req.method === 'GET') {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'
    if (isRateLimited(clientIp, ICAL_RATE_LIMIT_MAX, 'ical')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    const leagues = []
    for (const [federation, config] of Object.entries(ICAL_FEEDS)) {
      for (const [leagueCode, leagueConfig] of Object.entries(config.leagues)) {
        leagues.push({
          code: leagueCode,
          gender: leagueConfig.gender,
          federation: federation,
          level: leagueConfig.level || 'senior',
          cup: leagueConfig.cup || false
        })
      }
    }

    // Sort leagues: by gender (men first), then by code
    leagues.sort((a, b) => {
      if (a.gender !== b.gender) return a.gender === 'men' ? -1 : 1
      return a.code.localeCompare(b.code)
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      leagues
    }))
    return
  }

  // ==================== SUPABASE PROXY ENDPOINTS ====================

  // Helper: read JSON body
  const readJsonBody = (req, maxSize = MAX_BODY_SIZE) => new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
      if (body.length > maxSize) { req.destroy(); reject(new Error('Body too large')) }
    })
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}) }
      catch (e) { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })

  // POST /api/db — Generic database proxy
  if (url.pathname === '/api/db' && req.method === 'POST') {
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, DB_RATE_LIMIT_MAX, 'db')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }

    ;(async () => {
      try {
        const { table, action, params = {} } = await readJsonBody(req, MAX_MATCH_BODY_SIZE)

        if (!ALLOWED_TABLES.includes(table)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }

        // Require auth token for write operations (insert/update/upsert/delete)
        const WRITE_ACTIONS = ['insert', 'update', 'upsert', 'delete']
        if (WRITE_ACTIONS.includes(action)) {
          const authHeader = req.headers['authorization']
          const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

          if (!token) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Authentication required' }))
            return
          }

          // Verify token with Supabase
          const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(token)
          if (authError || !userData?.user) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid or expired token' }))
            return
          }
        }

        let query = supabaseAdmin.from(table)

        // Build query based on action
        if (action === 'select') {
          query = query.select(params.columns || '*', params.count ? { count: params.count, head: params.head || false } : undefined)
        } else if (action === 'insert') {
          query = query.insert(params.data)
        } else if (action === 'upsert') {
          query = query.upsert(params.data, params.onConflict ? { onConflict: params.onConflict } : undefined)
        } else if (action === 'update') {
          query = query.update(params.data)
        } else if (action === 'delete') {
          query = query.delete()
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }

        // Apply filters (validate column names against per-table whitelist)
        const ALLOWED_FILTER_TYPES = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'contains', 'is']
        const tableColumns = ALLOWED_COLUMNS[table]
        if (params.filters) {
          for (const f of params.filters) {
            if (!f.column || !ALLOWED_FILTER_TYPES.includes(f.type) || (tableColumns && !tableColumns.includes(f.column))) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid request' }))
              return
            }
            if (f.type === 'eq') query = query.eq(f.column, f.value)
            else if (f.type === 'neq') query = query.neq(f.column, f.value)
            else if (f.type === 'gt') query = query.gt(f.column, f.value)
            else if (f.type === 'gte') query = query.gte(f.column, f.value)
            else if (f.type === 'lt') query = query.lt(f.column, f.value)
            else if (f.type === 'lte') query = query.lte(f.column, f.value)
            else if (f.type === 'like') query = query.like(f.column, f.value)
            else if (f.type === 'ilike') query = query.ilike(f.column, f.value)
            else if (f.type === 'in') query = query.in(f.column, f.value)
            else if (f.type === 'contains') query = query.contains(f.column, f.value)
            else if (f.type === 'is') query = query.is(f.column, f.value)
          }
        }

        // Apply modifiers
        if (params.order) {
          for (const o of (Array.isArray(params.order) ? params.order : [params.order])) {
            if (!o.column || (tableColumns && !tableColumns.includes(o.column))) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Invalid request' }))
              return
            }
            query = query.order(o.column, { ascending: o.ascending !== false })
          }
        }
        if (params.limit) query = query.limit(params.limit)
        if (params.single) query = query.single()
        if (params.maybeSingle) query = query.maybeSingle()

        const { data, error, count } = await query

        if (error) {
          console.error(`[DB Proxy] ${action} ${table} error:`, error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Database operation failed' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data, error: null, count: count ?? undefined }))
        }
      } catch (err) {
        console.error('[DB Proxy] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Database operation failed' }))
      }
    })()
    return
  }

  // POST /api/db/rpc — RPC proxy
  if (url.pathname === '/api/db/rpc' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_RATE_LIMIT_MAX, 'storage')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    ;(async () => {
      try {
        // Require auth for RPC calls
        const authHeader = req.headers['authorization']
        const rpcToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
        if (!rpcToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Authentication required' }))
          return
        }
        const { data: rpcUser, error: rpcAuthError } = await supabaseAdmin.auth.getUser(rpcToken)
        if (rpcAuthError || !rpcUser?.user) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid or expired token' }))
          return
        }

        const { fn, params = {} } = await readJsonBody(req)
        if (!ALLOWED_RPC.includes(fn)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }
        const { data, error } = await supabaseAdmin.rpc(fn, params)
        if (error) {
          console.error(`[RPC Proxy] ${fn} error:`, error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Operation failed' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data, error: null }))
        }
      } catch (err) {
        console.error('[RPC Proxy] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Operation failed' }))
      }
    })()
    return
  }

  // POST /api/storage/upload — Upload file to Supabase Storage
  if (url.pathname === '/api/storage/upload' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_RATE_LIMIT_MAX, 'storage')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    ;(async () => {
      try {
        // Require auth for storage uploads
        const authHeader = req.headers['authorization']
        const uploadToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
        if (!uploadToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Authentication required' }))
          return
        }
        const { data: uploadUser, error: uploadAuthError } = await supabaseAdmin.auth.getUser(uploadToken)
        if (uploadAuthError || !uploadUser?.user) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid or expired token' }))
          return
        }

        const { bucket, path: filePath, fileBase64, contentType, upsert } = await readJsonBody(req, MAX_MATCH_BODY_SIZE)
        if (!ALLOWED_BUCKETS.includes(bucket)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }
        if (!isValidStoragePath(filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid file path' }))
          return
        }
        const fileBuffer = Buffer.from(fileBase64, 'base64')
        const { data, error } = await supabaseAdmin.storage
          .from(bucket)
          .upload(filePath, fileBuffer, { contentType: contentType || 'application/octet-stream', upsert: upsert !== false })
        if (error) {
          console.error('[Storage Upload] Supabase error:', error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Storage operation failed' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data, error: null }))
        }
      } catch (err) {
        console.error('[Storage Upload] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Storage operation failed' }))
      }
    })()
    return
  }

  // POST /api/storage/download — Download file from Supabase Storage
  if (url.pathname === '/api/storage/download' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_RATE_LIMIT_MAX, 'storage')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    ;(async () => {
      try {
        const { bucket, path: filePath } = await readJsonBody(req)
        if (!ALLOWED_BUCKETS.includes(bucket)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }
        if (!isValidStoragePath(filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid file path' }))
          return
        }
        const { data, error } = await supabaseAdmin.storage.from(bucket).download(filePath)
        if (error) {
          console.error('[Storage Download] Supabase error:', error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Storage operation failed' } }))
        } else {
          // Convert blob to base64
          const arrayBuffer = await data.arrayBuffer()
          const base64 = Buffer.from(arrayBuffer).toString('base64')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: base64, error: null }))
        }
      } catch (err) {
        console.error('[Storage Download] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Storage operation failed' }))
      }
    })()
    return
  }

  // POST /api/storage/list — List files in Supabase Storage
  if (url.pathname === '/api/storage/list' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_RATE_LIMIT_MAX, 'storage')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    ;(async () => {
      try {
        const { bucket, path: dirPath, options } = await readJsonBody(req)
        if (!ALLOWED_BUCKETS.includes(bucket)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }
        if (dirPath && !isValidStoragePath(dirPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid file path' }))
          return
        }
        const { data, error } = await supabaseAdmin.storage.from(bucket).list(dirPath, options || {})
        if (error) {
          console.error('[Storage List] Supabase error:', error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Storage operation failed' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data, error: null }))
        }
      } catch (err) {
        console.error('[Storage List] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Storage operation failed' }))
      }
    })()
    return
  }

  // POST /api/storage/signed-url — Create signed URL for Supabase Storage
  if (url.pathname === '/api/storage/signed-url' && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, STORAGE_RATE_LIMIT_MAX, 'storage')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    ;(async () => {
      try {
        const { bucket, path: filePath, expiresIn } = await readJsonBody(req)
        if (!ALLOWED_BUCKETS.includes(bucket)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid request' }))
          return
        }
        if (!isValidStoragePath(filePath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid file path' }))
          return
        }
        const MAX_SIGNED_URL_EXPIRY = 3600 // 1 hour max
        const safeExpiresIn = Math.min(expiresIn || 3600, MAX_SIGNED_URL_EXPIRY)
        const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(filePath, safeExpiresIn)
        if (error) {
          console.error('[Storage SignedUrl] Supabase error:', error.message)
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: null, error: { message: 'Storage operation failed' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data, error: null }))
        }
      } catch (err) {
        console.error('[Storage SignedUrl] Error:', err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Storage operation failed' }))
      }
    })()
    return
  }

  // POST /api/auth/* — Auth proxy endpoints
  if (url.pathname.startsWith('/api/auth/') && req.method === 'POST') {
    const clientIp = getClientIp(req)
    if (isRateLimited(clientIp, AUTH_RATE_LIMIT_MAX, 'auth')) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      res.end(JSON.stringify({ error: 'Too many requests' }))
      return
    }
    if (!supabaseAdmin) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Supabase not configured on server' }))
      return
    }

    const authAction = url.pathname.replace('/api/auth/', '')

    ;(async () => {
      try {
        const body = await readJsonBody(req)
        let result

        switch (authAction) {
          case 'sign-in': {
            const { data, error } = await supabaseAdmin.auth.signInWithPassword({
              email: body.email,
              password: body.password
            })
            result = { data: data ? { user: data.user, session: data.session } : null, error: error ? { message: error.message } : null }
            break
          }
          case 'sign-up': {
            const { data, error } = await supabaseAdmin.auth.admin.createUser({
              email: body.email,
              password: body.password,
              email_confirm: true,
              user_metadata: body.metadata || {}
            })
            result = { data: data ? { user: data.user } : null, error: error ? { message: error.message } : null }
            break
          }
          case 'sign-out': {
            // With service_role, we can use admin API to sign out a user by their JWT
            // But typically sign-out is client-side (just clear tokens)
            result = { data: null, error: null }
            break
          }
          case 'get-user': {
            // Verify JWT and return user
            const token = body.access_token
            if (!token) {
              result = { data: null, error: { message: 'No access token provided' } }
              break
            }
            const { data, error } = await supabaseAdmin.auth.getUser(token)
            result = { data: data ? { user: data.user } : null, error: error ? { message: error.message } : null }
            break
          }
          case 'reset-password': {
            const { data, error } = await supabaseAdmin.auth.resetPasswordForEmail(body.email, {
              redirectTo: body.redirectTo
            })
            result = { data, error: error ? { message: error.message } : null }
            break
          }
          case 'update-user': {
            const token = body.access_token
            if (!token) {
              result = { data: null, error: { message: 'No access token provided' } }
              break
            }
            // Get user from token first
            const { data: userData } = await supabaseAdmin.auth.getUser(token)
            if (!userData?.user) {
              result = { data: null, error: { message: 'Invalid token' } }
              break
            }
            const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userData.user.id, {
              email: body.email
            })
            result = { data: data ? { user: data.user } : null, error: error ? { message: error.message } : null }
            break
          }
          case 'delete-account': {
            const token = body.access_token
            if (!token) {
              result = { data: null, error: { message: 'No access token provided' } }
              break
            }
            const { data: userData } = await supabaseAdmin.auth.getUser(token)
            if (!userData?.user) {
              result = { data: null, error: { message: 'Invalid token' } }
              break
            }
            const { error } = await supabaseAdmin.auth.admin.deleteUser(userData.user.id)
            result = { data: null, error: error ? { message: error.message } : null }
            break
          }
          case 'profile': {
            // Get or update profile
            const token = body.access_token
            if (!token) {
              result = { data: null, error: { message: 'No access token provided' } }
              break
            }
            const { data: userData } = await supabaseAdmin.auth.getUser(token)
            if (!userData?.user) {
              result = { data: null, error: { message: 'Invalid token' } }
              break
            }
            if (body.updates) {
              // Update profile
              const { data, error } = await supabaseAdmin
                .from('profiles')
                .update(body.updates)
                .eq('user_id', userData.user.id)
                .select()
                .single()
              result = { data, error: error ? { message: error.message } : null }
            } else {
              // Get profile
              const { data, error } = await supabaseAdmin
                .from('profiles')
                .select('*')
                .eq('user_id', userData.user.id)
                .single()
              result = { data, error: error ? { message: error.message } : null }
            }
            break
          }
          default:
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid request' }))
            return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        console.error(`[Auth Proxy] ${authAction} error:`, err.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Authentication error' }))
      }
    })()
    return
  }

  // --- Dynamic landing page (root only) ---
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    ;(async () => {
      try {
        const host = req.headers.host || `localhost:${PORT}`
        const baseUrl = `http://${host}`
        const indoorRoles = [
          { key: 'referee', label: 'Referee', path: '/referee', color: '#3b82f6', icon: '🏁' },
          { key: 'bench_home', label: 'Home Bench', path: '/bench?team=home', color: '#10b981', icon: '🏠' },
          { key: 'bench_away', label: 'Away Bench', path: '/bench?team=away', color: '#ef4444', icon: '✈️' },
          { key: 'roster', label: 'Roster Upload', path: '/roster', color: '#ea580c', icon: '📋' }
        ]
        const beachRoles = [
          { key: 'beach_referee', label: 'Referee', path: '/beach-referee', color: '#3b82f6', icon: '🏁' },
          { key: 'beach_scoreboard', label: 'Scoreboard', path: '/beach-scoreboard', color: '#0f172a', icon: '📺' }
        ]

        // Generate QR codes as data URIs
        const generateQRCodes = async (roles) => Promise.all(
          roles.map(async (role) => {
            const url = `${baseUrl}${role.path}`
            const svg = await QRCode.toString(url, { type: 'svg', width: 200, margin: 1 })
            return { ...role, url, svg }
          })
        )
        const [indoorQR, beachQR] = await Promise.all([
          generateQRCodes(indoorRoles),
          generateQRCodes(beachRoles)
        ])

        // Active matches info
        const matchList = []
        for (const [matchId, matchData] of activeMatches.entries()) {
          const d = matchData.data || {}
          matchList.push({
            id: matchId,
            home: d.homeTeamName || d.home_team_name || 'Home',
            away: d.awayTeamName || d.away_team_name || 'Away',
            updatedAt: matchData.updatedAt
          })
        }

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenVolley Server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0; min-height: 100vh;
      display: flex; flex-direction: column; align-items: center; padding: 24px;
    }
    .header { text-align: center; margin-bottom: 32px; }
    .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
    .header .subtitle { color: #94a3b8; font-size: 14px; }
    .status-bar {
      display: flex; gap: 24px; justify-content: center; flex-wrap: wrap;
      margin-bottom: 32px; padding: 12px 24px;
      background: rgba(255,255,255,0.05); border-radius: 12px;
    }
    .status-item { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.green { background: #22c55e; }
    .dot.blue { background: #3b82f6; }
    .section { width: 100%; max-width: 1080px; margin-bottom: 32px; }
    .section-title { font-size: 20px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; }
    .grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px; width: 100%; max-width: 1080px; margin-bottom: 32px;
    }
    .card {
      background: #1e293b; border-radius: 16px; padding: 24px;
      text-align: center; border: 1px solid rgba(255,255,255,0.06);
      transition: transform 0.15s;
    }
    .card:hover { transform: translateY(-2px); }
    .card .icon { font-size: 28px; margin-bottom: 8px; }
    .card h3 { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .card .url { font-size: 11px; color: #64748b; word-break: break-all; margin-top: 12px; font-family: monospace; }
    .card .qr { background: #fff; border-radius: 10px; padding: 12px; display: inline-block; margin-top: 12px; }
    .card .qr svg { display: block; }
    .matches { width: 100%; max-width: 1080px; }
    .matches h2 { font-size: 18px; margin-bottom: 12px; }
    .match-row {
      background: #1e293b; border-radius: 10px; padding: 14px 20px;
      margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
    }
    .match-teams { font-weight: 600; }
    .match-time { font-size: 12px; color: #64748b; }
    .how-to {
      width: 100%; max-width: 1080px; margin-bottom: 32px;
      background: linear-gradient(135deg, #1e3a5f, #1e293b); border-radius: 16px;
      padding: 24px 32px; border: 1px solid rgba(59,130,246,0.2);
    }
    .how-to h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #93c5fd; }
    .steps { display: flex; gap: 24px; flex-wrap: wrap; }
    .step { flex: 1; min-width: 180px; display: flex; gap: 12px; align-items: flex-start; }
    .step-num {
      background: #3b82f6; color: #fff; width: 28px; height: 28px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; flex-shrink: 0;
    }
    .step-text { font-size: 14px; color: #cbd5e1; line-height: 1.4; }
    .step-text strong { color: #f1f5f9; }
    .footer { margin-top: 32px; font-size: 12px; color: #475569; text-align: center; }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🏐 OpenVolley Server</h1>
    <p class="subtitle">${baseUrl}</p>
  </div>

  <div class="status-bar">
    <div class="status-item">
      <span class="dot green"></span>
      Server running
    </div>
    <div class="status-item">
      <span class="dot blue"></span>
      ${connections.size} connected client${connections.size !== 1 ? 's' : ''}
    </div>
    <div class="status-item">
      <span class="dot blue"></span>
      ${activeMatches.size} active match${activeMatches.size !== 1 ? 'es' : ''}
    </div>
  </div>

  <div class="how-to">
    <h2>📱 How to Connect</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-text">Make sure all devices are on the <strong>same Wi-Fi network</strong></div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-text"><strong>Scan a QR code</strong> below with your phone camera to open the role</div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-text"><em>Optional:</em> Tap <strong>"Add to Home Screen"</strong> in your browser menu to install as an app</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">🏐 Indoor Volleyball</div>
    <div class="grid">
      ${indoorQR.map(r => `
      <div class="card">
        <div class="icon">${r.icon}</div>
        <h3 style="color: ${r.color}">${r.label}</h3>
        <div class="qr">${r.svg}</div>
        <div class="url"><a href="${r.url}">${r.url}</a></div>
      </div>
      `).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">🏖️ Beach Volleyball</div>
    <div class="grid">
      ${beachQR.map(r => `
      <div class="card">
        <div class="icon">${r.icon}</div>
        <h3 style="color: ${r.color}">${r.label}</h3>
        <div class="qr">${r.svg}</div>
        <div class="url"><a href="${r.url}">${r.url}</a></div>
      </div>
      `).join('')}
    </div>
  </div>

  ${matchList.length > 0 ? `
  <div class="matches">
    <h2>Active Matches</h2>
    ${matchList.map(m => `
    <div class="match-row">
      <span class="match-teams">${m.home} vs ${m.away}</span>
      <span class="match-time">${m.updatedAt ? new Date(m.updatedAt).toLocaleTimeString() : ''}</span>
    </div>
    `).join('')}
  </div>
  ` : ''}

  <div class="footer">
    OpenVolley — Open-source volleyball scoring
  </div>
</body>
</html>`
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch (err) {
        console.error('[Landing] Error generating landing page:', err.message)
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Internal Server Error')
      }
    })()
    return
  }

  // --- Static file serving (for standalone/local server) ---
  if (HAS_STATIC) {
    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname
    let filePath = join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname)

    // SPA fallback: /referee → /referee/index.html
    if (!extname(filePath) && existsSync(join(filePath, 'index.html'))) {
      filePath = join(filePath, 'index.html')
    }

    // Also handle /referee/ (with trailing slash)
    if (filePath.endsWith('/') && existsSync(join(filePath, 'index.html'))) {
      filePath = join(filePath, 'index.html')
    }

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      const content = readFileSync(filePath)
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(content)
      return
    }
  }

  res.writeHead(404)
  res.end('Not Found')
})

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  // Increase limits for match data
  maxPayload: 10 * 1024 * 1024, // 10MB
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  }
})

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`)
    console.error(`   Another instance of the server may be running.`)
    console.error(`   Stop it first, or set a different port: PORT=8081 ./openvolley-server-*\n`)
    process.exit(1)
  }
})

wss.on('connection', (ws, req) => {
  // Enforce global connection cap
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Server connection limit reached')
    return
  }

  const clientId = randomBytes(8).toString('hex')
  const ip = getClientIp(req)

  // Enforce per-IP connection cap
  let connectionsFromIp = 0
  for (const c of connections.values()) {
    if (c.ip === ip) connectionsFromIp++
  }
  if (connectionsFromIp >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections from this IP')
    return
  }

  const clientInfo = {
    ws,
    id: clientId,
    ip,
    matchId: null,
    role: null, // 'scoreboard', 'referee', 'bench'
    team: null, // 'home' or 'away' for bench clients
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)

  console.log(`✅ Client connected: ${clientId} from ${ip} (Total: ${connections.size})`)

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    mode: IS_CLOUD ? 'cloud' : 'local',
    timestamp: new Date().toISOString()
  }))

  ws.on('message', (data) => {
    // Per-client WebSocket rate limiting
    if (isWsRateLimited(clientId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }))
      ws.close(1008, 'Rate limit exceeded')
      return
    }

    try {
      const message = JSON.parse(data.toString())

      // Handle different message types
      switch (message.type) {
        case 'join_match':
          // Client joins a match room
          handleJoinMatch(clientInfo, message)
          break

        case 'leave_match':
          // Client leaves match room
          handleLeaveMatch(clientInfo)
          break

        case 'match_update':
          // Scoreboard sends match state update
          handleMatchUpdate(clientInfo, message)
          break

        case 'sync-match-data':
          // Scoreboard sends match data sync (frontend uses this format)
          handleSyncMatchData(clientInfo, message)
          break

        case 'match-action':
          // Scoreboard sends action (timeout, substitution, etc.) - frontend format
          handleMatchAction(clientInfo, message)
          break

        case 'action':
          // Scoreboard sends action (timeout, substitution, etc.) - legacy format
          handleAction(clientInfo, message)
          break

        case 'clear-all-matches':
          // Clear all matches (or all except one)
          handleClearMatches(message)
          break

        case 'delete-match':
          // Delete a specific match
          handleDeleteMatch(message)
          break

        case 'ping':
          // Heartbeat
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
          break

        case 'subscribe-match':
          // Frontend format for joining a match room (used by referee/bench/livescore)
          // Adapt to join_match format
          handleJoinMatch(clientInfo, {
            ...message,
            matchId: message.matchId,
            role: message.role || 'subscriber'
          })
          break

        default:
          console.log(`❓ Unknown message type: ${message.type}`)
      }
    } catch (err) {
      console.error('❌ Error parsing message:', err)
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format'
      }))
    }
  })

  ws.on('close', () => {
    handleClientDisconnect(clientInfo)
  })

  ws.on('error', (err) => {
    console.error(`❌ WebSocket error for ${clientId}:`, err.message)
  })
})

// Handle client joining a match room
function handleJoinMatch(clientInfo, message) {
  const { matchId, role, pin, team } = message

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Validate role and team
  const validatedRole = (role && VALID_ROLES.includes(role)) ? role : 'unknown'
  const validatedTeam = (team && VALID_TEAMS.includes(team)) ? team : null

  // PIN enforcement for roles that require it
  if (ROLES_REQUIRING_PIN.includes(validatedRole)) {
    const matchData = activeMatches.get(matchId) || activeMatches.get(String(matchId))
    const match = matchData?.match || matchData

    if (!match) {
      // No match data yet — scoreboard hasn't connected
      clientInfo.ws.send(JSON.stringify({
        type: 'error',
        message: 'Match not ready yet. The scoreboard must connect first.'
      }))
      return
    }

    let expectedPin = null
    let connectionEnabled = false

    if (validatedRole === 'referee') {
      expectedPin = match.refereePin
      connectionEnabled = match.refereeConnectionEnabled === true
    } else if (validatedRole === 'bench') {
      if (validatedTeam === 'home') {
        expectedPin = match.homeTeamPin
        connectionEnabled = match.homeTeamConnectionEnabled === true
      } else if (validatedTeam === 'away') {
        expectedPin = match.awayTeamPin
        connectionEnabled = match.awayTeamConnectionEnabled === true
      }
    }

    if (!connectionEnabled) {
      clientInfo.ws.send(JSON.stringify({
        type: 'error',
        message: 'Connection not enabled for this role'
      }))
      return
    }

    if (expectedPin != null && expectedPin !== '') {
      const pinStr = String(pin || '').trim()
      const expectedStr = String(expectedPin).trim()
      const pinBuf = Buffer.from(pinStr, 'utf8')
      const expectedBuf = Buffer.from(expectedStr, 'utf8')
      if (pinBuf.length !== expectedBuf.length || !timingSafeEqual(pinBuf, expectedBuf)) {
        clientInfo.ws.send(JSON.stringify({
          type: 'error',
          message: 'Invalid PIN'
        }))
        return
      }
    }
  }

  // Leave previous room if any
  if (clientInfo.matchId) {
    handleLeaveMatch(clientInfo)
  }

  // Enforce room cap
  if (!rooms.has(matchId) && rooms.size >= MAX_ROOMS) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Server room limit reached'
    }))
    return
  }

  // Update client info
  clientInfo.matchId = matchId
  clientInfo.role = validatedRole
  clientInfo.team = validatedTeam

  // Create room if doesn't exist
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      lastActivity: Date.now()
    })
  }

  // Add client to room
  const room = rooms.get(matchId)
  room.clients.add(clientInfo.id)
  room.lastActivity = Date.now()

  console.log(`🎯 ${clientInfo.id} (${validatedRole}) joined match ${matchId} (Room size: ${room.clients.size})`)

  // Notify client
  clientInfo.ws.send(JSON.stringify({
    type: 'joined_match',
    matchId,
    role: validatedRole,
    roomSize: room.clients.size
  }))

  // Notify other clients in room
  broadcastToRoom(matchId, {
    type: 'client_joined',
    clientId: clientInfo.id,
    role: validatedRole,
    roomSize: room.clients.size
  }, clientInfo.id) // Exclude sender
}

// Handle client leaving match room
function handleLeaveMatch(clientInfo) {
  if (!clientInfo.matchId) return

  const room = rooms.get(clientInfo.matchId)
  if (room) {
    room.clients.delete(clientInfo.id)

    console.log(`👋 ${clientInfo.id} left match ${clientInfo.matchId} (Room size: ${room.clients.size})`)

    // Notify other clients
    broadcastToRoom(clientInfo.matchId, {
      type: 'client_left',
      clientId: clientInfo.id,
      role: clientInfo.role,
      roomSize: room.clients.size
    }, clientInfo.id)

    // Clean up empty room
    if (room.clients.size === 0) {
      rooms.delete(clientInfo.matchId)
      activeMatches.delete(clientInfo.matchId)
      console.log(`🗑️  Empty room deleted: ${clientInfo.matchId}`)
    }
  }

  clientInfo.matchId = null
  clientInfo.role = null
}

// Handle match update from scoreboard
function handleMatchUpdate(clientInfo, message) {
  const { matchId, data } = message

  if (!matchId || !data || typeof data !== 'object') {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and data required'
    }))
    return
  }

  // Store match data (ephemeral)
  activeMatches.set(matchId, {
    matchId,
    data,
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })

  // Broadcast to all clients in the same room
  broadcastToRoom(matchId, {
    type: 'match_update',
    matchId,
    data,
    timestamp: new Date().toISOString()
  }, clientInfo.id) // Exclude sender to avoid echo

  console.log(`📤 Match update broadcasted to room ${matchId}`)
}

// Handle action (timeout, substitution, etc.)
function handleAction(clientInfo, message) {
  const { matchId, action } = message

  if (!matchId || !action) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID and action required'
    }))
    return
  }

  // Broadcast action to all clients in the room
  broadcastToRoom(matchId, {
    type: 'action',
    matchId,
    action,
    timestamp: new Date().toISOString(),
    from: clientInfo.id
  }, clientInfo.id) // Exclude sender

  console.log(`⚡ Action broadcasted to room ${matchId}: ${action.type}`)
}

// Handle client disconnect
function handleClientDisconnect(clientInfo) {
  handleLeaveMatch(clientInfo)
  connections.delete(clientInfo.id)
  wsRateLimitMap.delete(clientInfo.id)
  console.log(`❌ Client disconnected: ${clientInfo.id} (Total: ${connections.size})`)
}

// Handle sync-match-data from frontend scoreboard
function handleSyncMatchData(clientInfo, message) {
  // Only scoreboard clients can sync match data
  if (clientInfo.role && clientInfo.role !== 'scoreboard' && clientInfo.role !== 'unknown') {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Only scoreboard can sync match data'
    }))
    return
  }

  // Support both formats:
  // Frontend format: { matchId, match, homeTeam, awayTeam, homePlayers, awayPlayers, sets, events }
  // Legacy format: { matchId, match, teams, players, sets, events }
  const { matchId, match, teams, players, sets, events } = message
  const homeTeam = message.homeTeam || teams?.[0]
  const awayTeam = message.awayTeam || teams?.[1]
  const homePlayers = message.homePlayers || players?.filter(p => p.teamId === match?.homeTeamId) || []
  const awayPlayers = message.awayPlayers || players?.filter(p => p.teamId === match?.awayTeamId) || []

  if (!matchId) {
    clientInfo.ws.send(JSON.stringify({
      type: 'error',
      message: 'Match ID required'
    }))
    return
  }

  // Store/update match in activeMatches with all the data
  activeMatches.set(String(matchId), {
    matchId: String(matchId),
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    gameNumber: match?.gameN || match?.gameNumber || match?.game_n,
    updatedAt: new Date().toISOString(),
    updatedBy: clientInfo.id
  })

  // Enforce room cap
  if (!rooms.has(matchId) && rooms.size >= MAX_ROOMS) {
    clientInfo.ws.send(JSON.stringify({ type: 'error', message: 'Server room limit reached' }))
    return
  }

  // Ensure room exists
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString(),
      lastActivity: Date.now()
    })
  }

  // Add client to room if not already there
  const room = rooms.get(matchId)
  room.lastActivity = Date.now()
  if (!room.clients.has(clientInfo.id)) {
    room.clients.add(clientInfo.id)
    clientInfo.matchId = matchId
    clientInfo.role = 'scoreboard'
  }

  // Broadcast to other clients in the room
  // Use remapped variables (homeTeam, awayTeam, etc.) for consistency with storage and client
  broadcastToRoom(matchId, {
    type: 'match-data-update',
    matchId,
    match,
    homeTeam,
    awayTeam,
    homePlayers,
    awayPlayers,
    sets,
    events,
    timestamp: new Date().toISOString()
  }, clientInfo.id)

  console.log(`📤 Match data synced for ${matchId} (Game #${match?.gameN || 'unknown'})`)
}

// Handle match-action from frontend
function handleMatchAction(clientInfo, message) {
  const { matchId, action, actionData } = message

  if (!matchId || !action || typeof action !== 'string') {
    return
  }

  // Broadcast action to all clients in the room
  broadcastToRoom(matchId, {
    type: 'match-action',
    matchId,
    action,
    data: actionData,
    timestamp: new Date().toISOString(),
    from: clientInfo.id
  }, clientInfo.id)

  console.log(`⚡ Match action broadcasted to room ${matchId}: ${action}`)
}

// Handle clear-all-matches
function handleClearMatches(message) {
  const keepMatchId = message.keepMatchId

  if (keepMatchId) {
    // Clear all matches except the specified one
    const keysToDelete = []
    activeMatches.forEach((_, matchId) => {
      if (String(matchId) !== String(keepMatchId)) {
        keysToDelete.push(matchId)
      }
    })
    keysToDelete.forEach(matchId => {
      activeMatches.delete(matchId)
      rooms.delete(matchId)
    })
    console.log(`🗑️  Cleared ${keysToDelete.length} matches (kept ${keepMatchId})`)
  } else {
    // Clear all matches
    const count = activeMatches.size
    activeMatches.clear()
    rooms.clear()
    console.log(`🗑️  Cleared all ${count} matches`)
  }
}

// Handle delete-match
function handleDeleteMatch(message) {
  const { matchId } = message

  if (!matchId) return

  activeMatches.delete(matchId)
  rooms.delete(matchId)
  console.log(`🗑️  Deleted match ${matchId}`)
}

// Broadcast message to all clients in a specific room
function broadcastToRoom(matchId, message, excludeClientId = null) {
  const room = rooms.get(matchId)
  if (!room) return

  const data = JSON.stringify(message)
  let sent = 0

  room.clients.forEach((clientId) => {
    if (clientId === excludeClientId) return

    const clientInfo = connections.get(clientId)
    if (clientInfo && clientInfo.ws.readyState === 1) { // WebSocket.OPEN
      clientInfo.ws.send(data)
      sent++
    }
  })

  console.log(`📡 Broadcasted to ${sent} clients in room ${matchId}`)
}

// Periodic cleanup of stale connections
setInterval(() => {
  connections.forEach((clientInfo, clientId) => {
    if (clientInfo.ws.readyState === 3) { // WebSocket.CLOSED
      handleClientDisconnect(clientInfo)
    }
  })
}, 30000) // Every 30 seconds

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`)
    console.error(`   Another instance of the server may be running.`)
    console.error(`   Stop it first, or set a different port: PORT=8081 ./openvolley-server-*\n`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, () => {
  const ips = getLocalIPs()
  const primaryIP = ips[0]?.address || 'localhost'
  const mode = IS_CLOUD ? 'CLOUD' : IS_LOCAL ? 'LOCAL' : 'HYBRID'

  const ipLines = ips.map(ip => `  📡 ${ip.name}: http://${ip.address}:${PORT}`).join('\n')

  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🏐 OpenVolley Server — ${mode} MODE
║
║  Port: ${PORT}   Status: READY
║  Static files: ${HAS_STATIC ? 'YES' : 'NO'}
║
${ipLines || `  📡 http://localhost:${PORT}`}
║
║  Indoor Volleyball:
║  Referee:   http://${primaryIP}:${PORT}/referee
║  Bench:     http://${primaryIP}:${PORT}/bench
║  Roster:    http://${primaryIP}:${PORT}/roster
║
║  Beach Volleyball:
║  Referee:    http://${primaryIP}:${PORT}/beach-referee
║  Scoreboard: http://${primaryIP}:${PORT}/beach-scoreboard
║
║  Dashboard: http://${primaryIP}:${PORT}
╚════════════════════════════════════════════════════════════╝
  `)
})
