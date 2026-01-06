/**
 * Optional Backend Server for eScoresheet
 * Provides WebSocket relay for local network connections
 * This is OPTIONAL - the app works fully offline without this server
 *
 * Use cases:
 * 1. Local network: Scoreboard ↔ Referee/Bench sync (no internet needed)
 * 2. Cloud relay: Multiple locations (requires internet)
 *
 * Deploy to Railway.app (free tier) for cloud relay
 * Or run locally for local network only
 */

import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import nodemailer from 'nodemailer'
import ical from 'node-ical'

const PORT = process.env.PORT || 8080

// Email configuration - set these environment variables in Railway
// Option 1: Resend API (recommended - uses HTTPS, never blocked)
// RESEND_API_KEY
// Option 2: SMTP (may be blocked by some cloud providers)
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, CONTACT_EMAIL
console.log('[Email Config] RESEND_API_KEY:', process.env.RESEND_API_KEY ? 'SET' : 'NOT SET')
console.log('[Email Config] SMTP_HOST:', process.env.SMTP_HOST ? 'SET' : 'NOT SET')
console.log('[Email Config] SMTP_PORT:', process.env.SMTP_PORT || 'NOT SET')
console.log('[Email Config] SMTP_USER:', process.env.SMTP_USER ? 'SET' : 'NOT SET')
console.log('[Email Config] SMTP_PASS:', process.env.SMTP_PASS ? 'SET' : 'NOT SET')

// Resend email helper (uses HTTPS - works on all cloud platforms)
async function sendViaResend(to, subject, text) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'eScoresheet <noreply@openvolley.app>',
      to: [to],
      subject: subject,
      text: text
    })
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.message || 'Resend API error')
  }
  return data
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
const IS_CLOUD = process.env.RAILWAY_ENVIRONMENT || process.env.RENDER

// In-memory storage for active matches
// NOTE: This resets on server restart - Supabase is the source of truth for persistence
const activeMatches = new Map()
const connections = new Map()
const rooms = new Map() // Match rooms for isolated communication

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
    const events = await ical.fromURL(feedUrl)
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
  // In development or local network, allow all origins
  if (!IS_CLOUD) return '*'
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
  // Allow localhost/127.0.0.1 origins even in cloud mode (for development)
  if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    console.log(`[CORS] Allowing localhost origin: ${origin}`)
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)

  // Health check
  if (url.pathname === '/health' || url.pathname === '/') {
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
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      try {
        if (!body || body.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'Empty request body' }))
          return
        }

        const { pin, type = 'referee' } = JSON.parse(body)

        if (!pin || String(pin).length !== 6) {
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
          console.log(`[API] PIN validation failed for ${type}: ${pinStr}`)
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            success: false,
            error: 'No match found with this PIN. Make sure the main scoresheet is running and connected.'
          }))
        }
      } catch (err) {
        console.error('[API] Error validating PIN:', err)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: false, error: err.message || 'Invalid request body' }))
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
          refereePin: m.match?.refereePin,
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
        error: error.message || 'Internal server error',
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
      console.log(`[API] /api/match/${matchId} - Match not found. Active matches: ${Array.from(activeMatches.keys()).join(', ')}`)
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
    // Parse multipart form data (simplified - just log for now, email via mailto fallback)
    let body = ''
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
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

        console.log('[Contact] Received feedback:', {
          contactType: formData.contactType,
          area: formData.area,
          supportType: formData.supportType,
          severity: formData.severity,
          email: formData.email,
          comments: formData.comments?.substring(0, 100) + '...',
          timestamp: formData.timestamp
        })

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

        const subject = `[eScoresheet ${(typeLabels[formData.contactType] || formData.contactType).toUpperCase()}] ${formData.area}${formData.supportType ? ` - ${supportTypeLabels[formData.supportType] || formData.supportType}` : ''}`

        const emailBody = `
New ${typeLabels[formData.contactType] || formData.contactType} from eScoresheet

Contact Type: ${typeLabels[formData.contactType] || formData.contactType}
Area: ${formData.area}
${formData.supportType ? `Support Type: ${supportTypeLabels[formData.supportType] || formData.supportType}\n` : ''}${formData.severity ? `Severity: ${severityLabels[formData.severity] || formData.severity}\n` : ''}
From: ${formData.email}
URL: ${formData.url || 'N/A'}
User Agent: ${formData.userAgent || 'N/A'}
Timestamp: ${formData.timestamp || new Date().toISOString()}

Comments:
${formData.comments || 'No comments provided'}
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
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const matchData = JSON.parse(body)

        console.log('[Match Email] Sending match info to:', matchData.email)

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

  // Get official matches from iCal feeds
  if (url.pathname === '/api/official-matches' && req.method === 'GET') {
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

  res.writeHead(404)
  res.end('Not Found')
})

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  // Increase limits for match data
  maxPayload: 100 * 1024 * 1024, // 100MB
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

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).substring(7)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  const clientInfo = {
    ws,
    id: clientId,
    ip: ip ? ip.replace('::ffff:', '') : 'unknown', // Clean up IPv6 prefix
    matchId: null,
    role: null, // 'scoreboard', 'referee', 'bench'
    team: null, // 'home' or 'away' for bench clients
    connectedAt: new Date().toISOString()
  }

  connections.set(clientId, clientInfo)

  console.log(`✅ Client connected: ${clientId} from ${clientInfo.ip} (Total: ${connections.size})`)

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    mode: IS_CLOUD ? 'cloud' : 'local',
    timestamp: new Date().toISOString()
  }))

  ws.on('message', (data) => {
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

  // Leave previous room if any
  if (clientInfo.matchId) {
    handleLeaveMatch(clientInfo)
  }

  // Update client info
  clientInfo.matchId = matchId
  clientInfo.role = role || 'unknown'
  clientInfo.team = team || null // 'home' or 'away' for bench clients

  // Create room if doesn't exist
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString()
    })
  }

  // Add client to room
  const room = rooms.get(matchId)
  room.clients.add(clientInfo.id)

  console.log(`🎯 ${clientInfo.id} (${role}) joined match ${matchId} (Room size: ${room.clients.size})`)

  // Notify client
  clientInfo.ws.send(JSON.stringify({
    type: 'joined_match',
    matchId,
    role,
    roomSize: room.clients.size
  }))

  // Notify other clients in room
  broadcastToRoom(matchId, {
    type: 'client_joined',
    clientId: clientInfo.id,
    role,
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

  if (!matchId || !data) {
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
  console.log(`❌ Client disconnected: ${clientInfo.id} (Total: ${connections.size})`)
}

// Handle sync-match-data from frontend scoreboard
function handleSyncMatchData(clientInfo, message) {
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

  // Ensure room exists
  if (!rooms.has(matchId)) {
    rooms.set(matchId, {
      matchId,
      clients: new Set(),
      createdAt: new Date().toISOString()
    })
  }

  // Add client to room if not already there
  const room = rooms.get(matchId)
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

  if (!matchId || !action) {
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

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  🏐 eScoresheet WebSocket Server                          ║
║                                                            ║
║  Mode:     ${IS_CLOUD ? 'CLOUD RELAY' : 'LOCAL NETWORK'}                             ║
║  Port:     ${PORT}                                          ║
║  Status:   READY                                           ║
║                                                            ║
║  Endpoints:                                                ║
║  • Health:  http://localhost:${PORT}/health                 ║
║  • Status:  http://localhost:${PORT}/api/server/status      ║
║  • WS:      ws://localhost:${PORT}                          ║
╚════════════════════════════════════════════════════════════╝
  `)
})
