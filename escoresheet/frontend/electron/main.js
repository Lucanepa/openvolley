const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const serverManager = require('./serverManager')

// LAN relay ports. In production the in-process relay serves the app over HTTP
// so the renderer has a real http origin (not file://) — that's what lets the
// existing LAN client code resolve backend/WebSocket URLs, and lets tablets on
// the same Wi-Fi connect to http://<LAN-IP>:<RELAY_PORT>.
const RELAY_PORT = 5173
const RELAY_WS_PORT = 8080

let mainWindow
// Set once the relay is up (production). Null if it failed to start, in which
// case we fall back to loading the built files directly from disk.
let relayInfo = null

// True for URLs served by our own relay (localhost/127.0.0.1 on the relay port).
// Used to keep multi-window navigation (scoresheet/referee popups) in-app while
// still handing genuinely external links to the OS browser.
function isLocalRelayUrl(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      (u.port === String(RELAY_PORT))
  } catch { return false }
}

function createWindow() {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false // Don't show until ready
  })

  // Load the app
  if (isDev) {
    // Dev: the Vite dev server serves the app (and replicates the relay API).
    mainWindow.loadURL('http://localhost:5173')
    // Optionally open DevTools in development
    // mainWindow.webContents.openDevTools()
  } else if (relayInfo && relayInfo.running) {
    // Production: load from the in-process relay so window.location is a real
    // http origin. This makes the LAN client code work and lets the desktop
    // window keep camera/QR (http://localhost is a secure context).
    mainWindow.loadURL(`http://localhost:${RELAY_PORT}/`).catch(err => {
      console.error('Error loading from relay, falling back to file://:', err)
      loadFromDisk()
    })
  } else {
    // Relay could not start (e.g. port in use) — still open fully offline by
    // loading the built files directly. Tablet connection is unavailable here.
    loadFromDisk()
  }

  function loadFromDisk() {
    const indexPath = path.join(__dirname, '../dist/index.html')
    mainWindow.loadFile(indexPath).catch(err => {
      console.error('Error loading index.html:', err)
      mainWindow.loadURL('data:text/html,<h1>Error loading application</h1><p>Please rebuild the app.</p>')
    })
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    
    // Focus on window
    if (isDev) {
      mainWindow.focus()
    }
  })

  // Handle window closed
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // window.open() targets: keep same-origin relay pages (scoresheet/referee/
  // bench popups) inside the app as secure child windows; hand real external
  // links to the OS browser; deny anything else (file:, custom schemes).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalRelayUrl(url) || (isDev && url.startsWith('http://localhost:5173'))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            webSecurity: true,
            preload: path.join(__dirname, 'preload.js'),
          },
        },
      }
    }
    try {
      const scheme = new URL(url).protocol
      if (scheme === 'https:' || scheme === 'http:') {
        shell.openExternal(url)
      }
    } catch { /* invalid URL — ignore */ }
    return { action: 'deny' }
  })

  // Block in-window navigation to remote content (defense in depth). Allow the
  // local relay origin (production) and the Vite dev server (development).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('file://') ||
      isLocalRelayUrl(url) ||
      (isDev && url.startsWith('http://localhost:5173'))
    if (!allowed) {
      event.preventDefault()
    }
  })
}

// Create application menu
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Match',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-action', 'new-match')
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
          click: () => {
            app.quit()
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Fullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize', label: 'Minimize' },
        { role: 'close', label: 'Close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Connect a Tablet…',
          click: () => showTabletInfo()
        },
        { type: 'separator' },
        {
          label: 'User Guide',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-action', 'show-guide')
            }
          }
        },
        {
          label: 'About',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('menu-action', 'show-about')
            }
          }
        }
      ]
    }
  ]

  // macOS specific menu adjustments
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about', label: 'About ' + app.getName() },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide ' + app.getName() },
        { role: 'hideOthers', label: 'Hide Others' },
        { role: 'unhide', label: 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ' + app.getName() }
      ]
    })

    // Window menu
    template[4].submenu = [
      { role: 'close', label: 'Close' },
      { role: 'minimize', label: 'Minimize' },
      { role: 'zoom', label: 'Zoom' },
      { type: 'separator' },
      { role: 'front', label: 'Bring All to Front' }
    ]
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// Show the LAN addresses tablets can use to connect to this desktop.
function showTabletInfo() {
  const status = serverManager.getServerStatus()
  if (!status || !status.running) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Tablet Connection',
      message: 'The LAN server is not running.',
      detail: 'Tablet connection is unavailable in this session. Restart the app to try again.',
      buttons: ['OK'],
    })
    return
  }
  const ip = status.localIP
  const port = status.port
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Connect a Tablet',
    message: 'Tablets on the same Wi-Fi can open these addresses:',
    detail:
      `Scoretable / main:  http://${ip}:${port}/\n` +
      `Referee:            http://${ip}:${port}/referee.html\n` +
      `Bench:              http://${ip}:${port}/bench.html\n` +
      `Livescore display:  http://${ip}:${port}/livescore.html\n\n` +
      'The tablet must be on the same Wi-Fi/LAN as this computer.\n' +
      '(Camera/QR scanning works on this desktop, but not on tablets over plain HTTP.)',
    buttons: ['OK'],
  })
}

// App event handlers
app.whenReady().then(async () => {
  // Start the LAN relay before creating the window (production only). In dev the
  // Vite server already owns port 5173 and replicates the relay API. If startup
  // fails (e.g. port in use), the app still opens fully offline from disk — just
  // without tablet connectivity.
  if (!isDev) {
    try {
      relayInfo = await serverManager.startServer({ port: RELAY_PORT, wsPort: RELAY_WS_PORT })
      console.log(`[relay] LAN server on http://${relayInfo.localIP}:${relayInfo.port} (ws :${relayInfo.wsPort})`)
    } catch (err) {
      relayInfo = null
      console.error('[relay] Failed to start LAN server, opening offline from disk:', err.message)
    }
  }

  createWindow()
  createMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Stop server when app closes
    serverManager.stopServer().then(() => {
      app.quit()
    }).catch(() => {
      app.quit()
    })
  }
})

// IPC handlers for server management
ipcMain.handle('server:start', async (event, options) => {
  try {
    const status = await serverManager.startServer(options)
    return { success: true, status }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('server:stop', async () => {
  try {
    const result = await serverManager.stopServer()
    return { success: true, ...result }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('server:status', async () => {
  return serverManager.getServerStatus()
})

