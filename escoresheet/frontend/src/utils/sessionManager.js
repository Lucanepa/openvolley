// Session Management Utility
// Generates unique session IDs and manages match session locking

/**
 * Generate a unique session ID based on browser fingerprint and other factors
 */
export function generateSessionId() {
  // Try to get existing session ID from localStorage
  let sessionId = localStorage.getItem('escoresheet_session_id')
  
  if (sessionId) {
    return sessionId
  }
  
  // Generate a new unique session ID
  const parts = []
  
  // Browser fingerprint components
  const userAgent = navigator.userAgent || ''
  const language = navigator.language || ''
  const platform = navigator.platform || ''
  const screenWidth = window.screen?.width || 0
  const screenHeight = window.screen?.height || 0
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  
  // Create a hash-like string from browser info
  const browserFingerprint = `${userAgent}-${language}-${platform}-${screenWidth}x${screenHeight}-${timezone}`
  
  // Add timestamp for uniqueness
  const timestamp = Date.now()
  
  // Add random component
  const random = Math.random().toString(36).substring(2, 15)
  
  // Combine all parts
  parts.push(timestamp.toString(36))
  parts.push(random)
  parts.push(btoa(browserFingerprint).substring(0, 16))
  
  sessionId = parts.join('-')
  
  // Store in localStorage for persistence
  localStorage.setItem('escoresheet_session_id', sessionId)
  
  return sessionId
}

/**
 * Get or create session ID
 */
export function getSessionId() {
  return generateSessionId()
}

/**
 * Check if a match is locked by another session
 * Returns { locked: boolean, sessionId: string | null, isCurrentSession: boolean }
 */
export async function checkMatchSession(matchId) {
  if (!matchId) {
    return { locked: false, sessionId: null, isCurrentSession: false }
  }
  
  try {
    const { db } = await import('../db/db')
    const match = await db.matches.get(matchId)
    
    if (!match) {
      return { locked: false, sessionId: null, isCurrentSession: false }
    }
    
    const currentSessionId = getSessionId()
    const matchSessionId = match.sessionId || null
    
    if (!matchSessionId) {
      // Match is not locked - we can take it
      return { locked: false, sessionId: null, isCurrentSession: false }
    }
    
    if (matchSessionId === currentSessionId) {
      // We own this session
      return { locked: false, sessionId: matchSessionId, isCurrentSession: true }
    }
    
    // Another session has it locked
    return { locked: true, sessionId: matchSessionId, isCurrentSession: false }
  } catch (error) {
    console.error('Error checking match session:', error)
    return { locked: false, sessionId: null, isCurrentSession: false }
  }
}

/**
 * Lock a match to the current session
 */
export async function lockMatchSession(matchId) {
  if (!matchId) return false
  
  try {
    const { db } = await import('../db/db')
    const sessionId = getSessionId()
    await db.matches.update(matchId, { sessionId })
    return true
  } catch (error) {
    console.error('Error locking match session:', error)
    return false
  }
}

/**
 * Unlock a match (release session lock)
 */
export async function unlockMatchSession(matchId) {
  if (!matchId) return false
  
  try {
    const { db } = await import('../db/db')
    await db.matches.update(matchId, { sessionId: null })
    return true
  } catch (error) {
    console.error('Error unlocking match session:', error)
    return false
  }
}

/**
 * Verify game PIN for a match
 */
export async function verifyGamePin(matchId, pin) {
  if (!matchId) return false
  
  try {
    const { db } = await import('../db/db')
    const match = await db.matches.get(matchId)
    
    if (!match) return false
    
    // Test matches have no PIN
    if (match.test === true) {
      return false // Test matches don't use PIN
    }
    
    // If match has no gamePin, allow access (backward compatibility)
    if (!match.gamePin) {
      return true
    }
    
    return match.gamePin === pin
  } catch (error) {
    console.error('Error verifying game PIN:', error)
    return false
  }
}

