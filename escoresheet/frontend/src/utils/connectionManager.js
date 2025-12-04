/**
 * Connection Manager for Bluetooth and LAN connectivity
 * Handles connections between scoreboard and referee devices
 */

// Bluetooth connection manager
export class BluetoothConnectionManager {
  constructor(onData, onError, onDisconnect) {
    this.device = null
    this.server = null
    this.service = null
    this.characteristic = null
    this.onData = onData
    this.onError = onError
    this.onDisconnect = onDisconnect
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
  }

  async connect() {
    try {
      // Check if Bluetooth is available
      if (!navigator.bluetooth) {
        throw new Error('Bluetooth is not supported in this browser. Please use Chrome/Edge on desktop or Android.')
      }

      // Request device (using a custom service UUID for volleyball scoring)
      const serviceUUID = '0000ff00-0000-1000-8000-00805f9b34fb'
      const characteristicUUID = '0000ff01-0000-1000-8000-00805f9b34fb'

      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [serviceUUID] }],
        optionalServices: [serviceUUID]
      })

      // Add disconnect listener
      this.device.addEventListener('gattserverdisconnected', () => {
        this.isConnected = false
        if (this.onDisconnect) this.onDisconnect()
        this.attemptReconnect()
      })

      // Connect to GATT server
      this.server = await this.device.gatt.connect()
      
      // Get service
      this.service = await this.server.getPrimaryService(serviceUUID)
      
      // Get characteristic
      this.characteristic = await this.service.getCharacteristic(characteristicUUID)
      
      // Start notifications
      await this.characteristic.startNotifications()
      this.characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const value = event.target.value
        const decoder = new TextDecoder()
        const data = JSON.parse(decoder.decode(value))
        if (this.onData) this.onData(data)
      })

      this.isConnected = true
      this.reconnectAttempts = 0
      return { success: true, deviceName: this.device.name || 'Bluetooth Device' }
    } catch (error) {
      this.isConnected = false
      if (error.name === 'NotFoundError') {
        throw new Error('No Bluetooth device found. Make sure the scoreboard is advertising.')
      } else if (error.name === 'SecurityError') {
        throw new Error('Bluetooth permission denied. Please allow Bluetooth access.')
      } else if (error.name === 'NetworkError') {
        throw new Error('Bluetooth connection failed. Please try again.')
      }
      throw error
    }
  }

  async disconnect() {
    try {
      if (this.characteristic) {
        await this.characteristic.stopNotifications()
      }
      if (this.device && this.device.gatt.connected) {
        await this.device.gatt.disconnect()
      }
      this.isConnected = false
      this.device = null
      this.server = null
      this.service = null
      this.characteristic = null
    } catch (error) {
      console.error('Error disconnecting Bluetooth:', error)
    }
  }

  async send(data) {
    if (!this.isConnected || !this.characteristic) {
      throw new Error('Not connected to Bluetooth device')
    }

    try {
      const encoder = new TextEncoder()
      const jsonData = JSON.stringify(data)
      await this.characteristic.writeValue(encoder.encode(jsonData))
    } catch (error) {
      console.error('Error sending data via Bluetooth:', error)
      throw error
    }
  }

  async attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.onError) {
        this.onError(new Error('Max reconnection attempts reached'))
      }
      return
    }

    this.reconnectAttempts++
    setTimeout(async () => {
      try {
        await this.connect()
      } catch (error) {
        console.error('Reconnection attempt failed:', error)
        this.attemptReconnect()
      }
    }, 2000 * this.reconnectAttempts) // Exponential backoff
  }
}

// LAN connection manager using WebSocket (requires WebSocket server on scoreboard)
// Alternative: Use WebRTC for peer-to-peer (more complex, requires signaling)
export class LANConnectionManager {
  constructor(onData, onError, onDisconnect) {
    this.ws = null
    this.onData = onData
    this.onError = onError
    this.onDisconnect = onDisconnect
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectTimeout = null
    this.url = null
  }

  async connect(ipAddress, port = 8080) {
    try {
      // Use WebSocket for LAN connection
      // Note: This requires a WebSocket server running on the scoreboard device
      // For production, you might want to use WebRTC for true peer-to-peer
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      this.url = `${protocol}//${ipAddress}:${port}`
      
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
          this.isConnected = true
          this.reconnectAttempts = 0
          resolve({ success: true, url: this.url })
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (this.onData) this.onData(data)
          } catch (error) {
            console.error('Error parsing WebSocket message:', error)
          }
        }

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          if (this.onError) this.onError(error)
          reject(new Error('Connection failed. Make sure the scoreboard is running a WebSocket server.'))
        }

        this.ws.onclose = () => {
          this.isConnected = false
          if (this.onDisconnect) this.onDisconnect()
          // Attempt to reconnect if not manually closed
          if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
            this.attemptReconnect()
          }
        }

        // Timeout after 10 seconds
        setTimeout(() => {
          if (!this.isConnected) {
            this.ws.close()
            reject(new Error('Connection timeout. Please check the IP address and port, and ensure the scoreboard WebSocket server is running.'))
          }
        }, 10000)
      })
    } catch (error) {
      this.isConnected = false
      throw error
    }
  }

  async disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    this.isConnected = false
    this.url = null
  }

  async send(data) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to LAN device')
    }

    try {
      this.ws.send(JSON.stringify(data))
    } catch (error) {
      console.error('Error sending data via LAN:', error)
      throw error
    }
  }

  async attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.onError) {
        this.onError(new Error('Max reconnection attempts reached'))
      }
      return
    }

    this.reconnectAttempts++
    this.reconnectTimeout = setTimeout(async () => {
      try {
        const url = new URL(this.url)
        await this.connect(url.hostname, url.port || 8080)
      } catch (error) {
        console.error('Reconnection attempt failed:', error)
        this.attemptReconnect()
      }
    }, 2000 * this.reconnectAttempts) // Exponential backoff
  }
}

// Internet connection manager using WebSocket over internet
export class InternetConnectionManager {
  constructor(onData, onError, onDisconnect) {
    this.ws = null
    this.onData = onData
    this.onError = onError
    this.onDisconnect = onDisconnect
    this.isConnected = false
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectTimeout = null
    this.url = null
  }

  async connect(url) {
    try {
      // Ensure URL has protocol
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        // Default to wss:// for security, fallback to ws://
        url = url.startsWith('http://') 
          ? url.replace('http://', 'ws://')
          : url.startsWith('https://')
          ? url.replace('https://', 'wss://')
          : (url.includes(':') && !url.includes('://') ? `ws://${url}` : `wss://${url}`)
      }
      
      this.url = url
      
      return new Promise((resolve, reject) => {
        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
          this.isConnected = true
          this.reconnectAttempts = 0
          resolve({ success: true, url: this.url })
        }

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (this.onData) this.onData(data)
          } catch (error) {
            console.error('Error parsing WebSocket message:', error)
          }
        }

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error)
          if (this.onError) this.onError(error)
          reject(new Error('Connection failed. Please check the URL and ensure the server is accessible.'))
        }

        this.ws.onclose = () => {
          this.isConnected = false
          if (this.onDisconnect) this.onDisconnect()
          // Attempt to reconnect if not manually closed
          if (this.ws && this.ws.readyState === WebSocket.CLOSED) {
            this.attemptReconnect()
          }
        }

        // Timeout after 15 seconds (longer for internet connections)
        setTimeout(() => {
          if (!this.isConnected) {
            this.ws.close()
            reject(new Error('Connection timeout. Please check the URL and your internet connection.'))
          }
        }, 15000)
      })
    } catch (error) {
      this.isConnected = false
      throw error
    }
  }

  async disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    
    this.isConnected = false
    this.url = null
  }

  async send(data) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to internet device')
    }

    try {
      this.ws.send(JSON.stringify(data))
    } catch (error) {
      console.error('Error sending data via internet:', error)
      throw error
    }
  }

  async attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.onError) {
        this.onError(new Error('Max reconnection attempts reached'))
      }
      return
    }

    this.reconnectAttempts++
    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connect(this.url)
      } catch (error) {
        console.error('Reconnection attempt failed:', error)
        this.attemptReconnect()
      }
    }, 3000 * this.reconnectAttempts) // Exponential backoff
  }
}

// Main connection manager that handles Bluetooth, LAN, and Internet
export class ConnectionManager {
  constructor(onData, onError, onDisconnect) {
    this.bluetoothManager = new BluetoothConnectionManager(onData, onError, onDisconnect)
    this.lanManager = new LANConnectionManager(onData, onError, onDisconnect)
    this.internetManager = new InternetConnectionManager(onData, onError, onDisconnect)
    this.currentConnection = null // 'bluetooth' | 'lan' | 'internet' | null
    this.onData = onData
    this.onError = onError
    this.onDisconnect = onDisconnect
  }

  async connectBluetooth() {
    try {
      await this.disconnect() // Disconnect any existing connection
      const result = await this.bluetoothManager.connect()
      this.currentConnection = 'bluetooth'
      return result
    } catch (error) {
      throw error
    }
  }

  async connectLAN(ipAddress, port = 8080) {
    try {
      await this.disconnect() // Disconnect any existing connection
      const result = await this.lanManager.connect(ipAddress, port)
      this.currentConnection = 'lan'
      return result
    } catch (error) {
      throw error
    }
  }

  async connectInternet(url) {
    try {
      await this.disconnect() // Disconnect any existing connection
      const result = await this.internetManager.connect(url)
      this.currentConnection = 'internet'
      return result
    } catch (error) {
      throw error
    }
  }

  async disconnect() {
    if (this.currentConnection === 'bluetooth') {
      await this.bluetoothManager.disconnect()
    } else if (this.currentConnection === 'lan') {
      await this.lanManager.disconnect()
    } else if (this.currentConnection === 'internet') {
      await this.internetManager.disconnect()
    }
    this.currentConnection = null
  }

  async send(data) {
    if (this.currentConnection === 'bluetooth') {
      await this.bluetoothManager.send(data)
    } else if (this.currentConnection === 'lan') {
      await this.lanManager.send(data)
    } else if (this.currentConnection === 'internet') {
      await this.internetManager.send(data)
    } else {
      throw new Error('No active connection')
    }
  }

  isConnected() {
    if (this.currentConnection === 'bluetooth') {
      return this.bluetoothManager.isConnected
    } else if (this.currentConnection === 'lan') {
      return this.lanManager.isConnected
    } else if (this.currentConnection === 'internet') {
      return this.internetManager.isConnected
    }
    return false
  }

  getConnectionType() {
    return this.currentConnection
  }

  async scanLANDevices() {
    return await this.lanManager.scanForDevices()
  }
}

