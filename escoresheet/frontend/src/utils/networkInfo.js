/**
 * Network Info Utilities
 * Functions for getting local IP, server status, and generating QR codes
 */

/**
 * Get local IP address using RTCPeerConnection trick
 * Works in most browsers except some strict privacy modes
 */
export async function getLocalIP() {
  return new Promise((resolve) => {
    const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection
    if (!RTCPeerConnection) {
      resolve(null)
      return
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: [] })
      pc.createDataChannel('')

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          const candidate = event.candidate.candidate
          const match = candidate.match(/([0-9]{1,3}\.){3}[0-9]{1,3}/)
          if (match) {
            const ip = match[0]
            // Filter for local IPs only
            if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
              pc.close()
              resolve(ip)
            }
          }
        }
      }

      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(() => resolve(null))

      // Timeout after 3 seconds
      setTimeout(() => {
        pc.close()
        resolve(null)
      }, 3000)
    } catch (err) {
      resolve(null)
    }
  })
}

/**
 * Get server status from the API
 */
export async function getServerStatus() {
  try {
    const protocol = window.location.protocol
    const hostname = window.location.hostname
    const port = window.location.port || (protocol === 'https:' ? '443' : '80')

    const response = await fetch(`${protocol}//${hostname}:${port}/api/server/status`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      return { running: false, error: 'Server not responding' }
    }

    const data = await response.json()
    return {
      running: true,
      ...data
    }
  } catch (error) {
    return { running: false, error: error.message }
  }
}

/**
 * Get connection count from the API
 */
export async function getConnectionCount() {
  try {
    const protocol = window.location.protocol
    const hostname = window.location.hostname
    const port = window.location.port || (protocol === 'https:' ? '443' : '80')

    const response = await fetch(`${protocol}//${hostname}:${port}/api/server/connections`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })

    if (!response.ok) {
      return { totalClients: 0, matchSubscriptions: {} }
    }

    return await response.json()
  } catch (error) {
    return { totalClients: 0, matchSubscriptions: {} }
  }
}

/**
 * Generate QR code as data URL using a simple QR code library approach
 * Uses the QR Server API for simplicity (external service)
 * For offline use, consider bundling a QR code library like 'qrcode'
 */
export function generateQRCodeUrl(text, size = 200) {
  // Use Google Charts API (simple, no library needed)
  // Note: For production/offline, consider using a bundled library
  const encoded = encodeURIComponent(text)
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encoded}`
}

/**
 * Generate QR code locally using canvas (no external dependency)
 * This is a simplified implementation - for production, use a proper QR library
 */
export async function generateQRCodeLocal(text, size = 200) {
  // For a full implementation, you'd use a library like 'qrcode'
  // This returns the external URL as fallback
  return generateQRCodeUrl(text, size)
}

/**
 * Copy text to clipboard with fallback for older browsers
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
      return { success: true }
    }

    // Fallback for older browsers
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.left = '-9999px'
    textArea.style.top = '-9999px'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    try {
      document.execCommand('copy')
      document.body.removeChild(textArea)
      return { success: true }
    } catch (err) {
      document.body.removeChild(textArea)
      return { success: false, error: 'Copy failed' }
    }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

/**
 * Build the URLs for different apps
 */
export function buildAppUrls(localIP, port, protocol = 'http') {
  const baseUrl = `${protocol}://${localIP}:${port}`
  return {
    main: baseUrl,
    referee: `${baseUrl}/referee`,
    bench: `${baseUrl}/bench`,
    livescore: `${baseUrl}/livescore`,
    uploadRoster: `${baseUrl}/upload_roster`
  }
}

/**
 * Build WebSocket URL
 */
export function buildWebSocketUrl(localIP, wsPort = 8080, secure = false) {
  const protocol = secure ? 'wss' : 'ws'
  return `${protocol}://${localIP}:${wsPort}`
}

/**
 * Check if we're running on HTTPS
 */
export function isSecureContext() {
  return window.location.protocol === 'https:' || window.location.hostname === 'localhost'
}

/**
 * Get the cloud backend URL if configured
 */
export function getCloudBackendUrl() {
  return import.meta.env.VITE_BACKEND_URL || null
}

/**
 * Build cloud URLs for remote access
 */
export function buildCloudUrls(backendUrl) {
  if (!backendUrl) return null

  // Remove trailing slash if present
  const baseUrl = backendUrl.replace(/\/$/, '')

  return {
    main: baseUrl,
    referee: `${baseUrl}/referee`,
    bench: `${baseUrl}/bench`,
    livescore: `${baseUrl}/livescore`,
    uploadRoster: `${baseUrl}/upload_roster`
  }
}
