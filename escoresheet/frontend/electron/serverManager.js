/**
 * Server Manager for Electron
 * Manages the production server process
 */

const { spawn } = require('child_process')
const path = require('path')
const { networkInterfaces } = require('os')

let serverProcess = null
let serverStatus = {
  running: false,
  port: null,
  wsPort: null,
  localIP: null,
  hostname: 'escoresheet.local'
}

function getLocalIP() {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return '127.0.0.1'
}

function startServer(options = {}) {
  return new Promise((resolve, reject) => {
    if (serverProcess) {
      return resolve({ ...serverStatus, alreadyRunning: true })
    }

    const serverPath = path.join(__dirname, '../server.js')
    const distPath = path.join(__dirname, '../dist')
    
    // Check if dist exists
    const fs = require('fs')
    if (!fs.existsSync(distPath)) {
      return reject(new Error('Dist folder not found. Please run "npm run build" first.'))
    }

    // Generate certs if they don't exist and HTTPS is enabled
    const certPath = path.join(__dirname, '../localhost.pem')
    const keyPath = path.join(__dirname, '../localhost-key.pem')
    const useHttps = options.https !== false

    if (useHttps && (!fs.existsSync(certPath) || !fs.existsSync(keyPath))) {
      console.log('Generating SSL certificates...')
      try {
        const { execSync } = require('child_process')
        const generateCertsPath = path.join(__dirname, '../generate-certs.js')
        execSync(`node "${generateCertsPath}"`, { stdio: 'inherit' })
      } catch (err) {
        console.warn('Failed to generate certificates:', err.message)
      }
    }

    const env = {
      ...process.env,
      PORT: options.port || 5173,
      WS_PORT: options.wsPort || 8080,
      HTTPS: useHttps ? 'true' : 'false',
      HOSTNAME: options.hostname || 'escoresheet.local',
      NODE_ENV: 'production'
    }

    serverProcess = spawn('node', [serverPath], {
      env,
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let serverReady = false
    const output = []

    serverProcess.stdout.on('data', (data) => {
      const message = data.toString()
      output.push(message)
      console.log('[Server]', message.trim())
      
      // Check if server is ready
      if (message.includes('Server running') && !serverReady) {
        serverReady = true
        serverStatus = {
          running: true,
          port: parseInt(env.PORT),
          wsPort: parseInt(env.WS_PORT),
          localIP: getLocalIP(),
          hostname: env.HOSTNAME,
          protocol: useHttps ? 'https' : 'http',
          wsProtocol: useHttps ? 'wss' : 'ws'
        }
        resolve(serverStatus)
      }
    })

    serverProcess.stderr.on('data', (data) => {
      const message = data.toString()
      console.error('[Server Error]', message.trim())
      output.push(message)
    })

    serverProcess.on('error', (error) => {
      console.error('[Server] Failed to start:', error)
      serverProcess = null
      reject(error)
    })

    serverProcess.on('exit', (code) => {
      console.log(`[Server] Process exited with code ${code}`)
      serverProcess = null
      serverStatus.running = false
    })

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!serverReady) {
        if (serverProcess) {
          serverProcess.kill()
          serverProcess = null
        }
        reject(new Error('Server startup timeout'))
      }
    }, 10000)
  })
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      return resolve({ success: true, message: 'Server not running' })
    }

    serverProcess.on('exit', () => {
      serverStatus.running = false
      resolve({ success: true, message: 'Server stopped' })
    })

    serverProcess.kill('SIGTERM')
    serverProcess = null
  })
}

function getServerStatus() {
  return {
    ...serverStatus,
    localIP: getLocalIP()
  }
}

module.exports = {
  startServer,
  stopServer,
  getServerStatus
}
