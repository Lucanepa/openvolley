/**
 * Broadcast Server for Scoreboard
 * Handles WebSocket and Bluetooth broadcasting to referee devices
 */

// WebSocket Server Manager
export class WebSocketBroadcastServer {
  constructor(port = 8080) {
    this.port = port
    this.clients = new Set()
    this.server = null
    this.isRunning = false
  }

  async start(onClientConnect, onClientDisconnect) {
    // Note: This requires a WebSocket server library
    // For browser-based apps, you'll need to use a WebSocket server library
    // or run a separate Node.js server
    
    // Example using ws library (Node.js):
    // const WebSocket = require('ws')
    // this.server = new WebSocket.Server({ port: this.port })
    
    // For browser-based implementation, you might need:
    // 1. A separate Node.js server
    // 2. Or use WebRTC for peer-to-peer
    // 3. Or use a service like Socket.io
    
    console.warn('WebSocket server requires a Node.js backend or WebRTC implementation')
    console.warn('For now, use the database-based connection or implement a WebSocket server')
    
    // Placeholder for WebSocket server implementation
    this.isRunning = true
    return { success: true, port: this.port }
  }

  async stop() {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.clients.clear()
    this.isRunning = false
  }

  broadcast(data) {
    const message = JSON.stringify(data)
    this.clients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message)
      }
    })
  }

  getClientCount() {
    return this.clients.size
  }
}

// Bluetooth Broadcast Manager
export class BluetoothBroadcastManager {
  constructor() {
    this.isAdvertising = false
    this.connectedDevices = new Set()
  }

  async startAdvertising(serviceUUID = '0000ff00-0000-1000-8000-00805f9b34fb') {
    // Note: Web Bluetooth Server API is experimental
    // Currently only available in Chrome/Edge with flags enabled
    // For production, you may need a native app or browser extension
    
    if (!navigator.bluetooth) {
      throw new Error('Bluetooth is not supported in this browser')
    }

    // Check if Web Bluetooth Server API is available
    if (!navigator.bluetooth.requestLEScan) {
      console.warn('Web Bluetooth Server API is not available. Use Chrome/Edge with experimental flags enabled.')
      throw new Error('Bluetooth advertising requires Web Bluetooth Server API (experimental)')
    }

    // Placeholder for Bluetooth advertising implementation
    this.isAdvertising = true
    return { success: true }
  }

  async stopAdvertising() {
    this.isAdvertising = false
    this.connectedDevices.clear()
  }

  broadcast(data) {
    // Send data to all connected devices
    const message = JSON.stringify(data)
    this.connectedDevices.forEach(device => {
      // Send via Bluetooth characteristic
      // Implementation depends on Web Bluetooth Server API
    })
  }

  getConnectedDeviceCount() {
    return this.connectedDevices.size
  }
}

// Main Broadcast Manager
export class BroadcastManager {
  constructor(port = 8080) {
    this.wsServer = new WebSocketBroadcastServer(port)
    this.btManager = new BluetoothBroadcastManager()
    this.broadcastMethods = [] // 'websocket' | 'bluetooth'
  }

  async startWebSocket(port) {
    try {
      await this.wsServer.start()
      this.broadcastMethods.push('websocket')
      return { success: true, port: this.wsServer.port }
    } catch (error) {
      console.error('Failed to start WebSocket server:', error)
      throw error
    }
  }

  async startBluetooth() {
    try {
      await this.btManager.startAdvertising()
      this.broadcastMethods.push('bluetooth')
      return { success: true }
    } catch (error) {
      console.error('Failed to start Bluetooth advertising:', error)
      throw error
    }
  }

  async stop() {
    await this.wsServer.stop()
    await this.btManager.stopAdvertising()
    this.broadcastMethods = []
  }

  broadcast(data) {
    // Broadcast to all active connections
    if (this.broadcastMethods.includes('websocket')) {
      this.wsServer.broadcast(data)
    }
    if (this.broadcastMethods.includes('bluetooth')) {
      this.btManager.broadcast(data)
    }
  }

  getConnectionCount() {
    return this.wsServer.getClientCount() + this.btManager.getConnectedDeviceCount()
  }
}

// Helper function to get local IP address for display
export async function getLocalIP() {
  return new Promise((resolve) => {
    const RTCPeerConnection = window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection
    if (!RTCPeerConnection) {
      resolve(null)
      return
    }

    const pc = new RTCPeerConnection({ iceServers: [] })
    pc.createDataChannel('')
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidate = event.candidate.candidate
        const match = candidate.match(/([0-9]{1,3}\.){3}[0-9]{1,3}/)
        if (match) {
          const ip = match[0]
          // Filter out non-local IPs
          if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
            pc.close()
            resolve(ip)
          }
        }
      }
    }
    pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => resolve(null))
    
    // Timeout after 2 seconds
    setTimeout(() => {
      pc.close()
      resolve(null)
    }, 2000)
  })
}

