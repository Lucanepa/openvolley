# Production Server Setup

This document explains how to run the eScoresheet application with a production server that includes WebSocket support for real-time connections between referee, bench, livescore, and upload apps.

## Overview

The production server (`server.js`) provides:
- **HTTP Server**: Serves all static files (HTML, JS, CSS, etc.) from the `dist` directory
- **WebSocket Server**: Enables real-time communication between scoreboard, referee, bench, and livescore apps

## Quick Start

### 1. Build the Application

```bash
npm run build
```

This creates the `dist` directory with all built files.

### 2. Start the Production Server

```bash
npm start
```

Or build and start in one command:

```bash
npm run start:prod
```

The server will start on:
- **HTTP Server**: `http://localhost:5173` (or port specified by `PORT` env variable)
- **WebSocket Server**: `ws://localhost:8080` (or port specified by `WS_PORT` env variable)

## Configuration

You can configure the server using environment variables:

```bash
PORT=3000 WS_PORT=8080 npm start
```

- `PORT`: HTTP server port (default: 5173)
- `WS_PORT`: WebSocket server port (default: 8080)

## Accessing the Apps

Once the server is running, you can access:

- **Main Scoreboard**: http://localhost:5173/
- **Referee App**: http://localhost:5173/referee.html or http://localhost:5173/referee
- **Bench App**: http://localhost:5173/bench.html or http://localhost:5173/bench
- **Livescore App**: http://localhost:5173/livescore.html or http://localhost:5173/livescore
- **Upload Roster**: http://localhost:5173/upload_roster.html or http://localhost:5173/upload_roster
- **Scoresheet**: http://localhost:5173/scoresheet.html or http://localhost:5173/scoresheet

## WebSocket Connection

The WebSocket server runs on port 8080 by default. Clients can connect using:

```javascript
// For LAN connections
const ws = new WebSocket('ws://localhost:8080')

// For production (HTTPS), use secure WebSocket
const ws = new WebSocket('wss://your-domain.com:8080')
```

The `connectionManager.js` in the frontend code handles WebSocket connections automatically.

## Deployment

### Option 1: Standalone Server

Run the server on your own infrastructure:

```bash
npm run build
npm start
```

Use a process manager like PM2 for production:

```bash
npm install -g pm2
pm2 start server.js --name escoresheet
pm2 save
pm2 startup
```

### Option 2: Docker

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
COPY server.js ./
EXPOSE 5173 8080
CMD ["node", "server.js"]
```

Build and run:

```bash
docker build -t escoresheet .
docker run -p 5173:5173 -p 8080:8080 escoresheet
```

### Option 3: Reverse Proxy (Recommended for Production)

Use nginx or another reverse proxy in front of the Node.js server:

```nginx
# HTTP server
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# WebSocket server
server {
    listen 8080;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

For HTTPS, use Let's Encrypt and configure SSL certificates.

## Network Access

To allow other devices on your network to connect:

1. Find your local IP address:
   - Windows: `ipconfig` (look for IPv4 Address)
   - Mac/Linux: `ifconfig` or `ip addr`

2. Access from other devices using:
   - `http://YOUR_IP:5173` for the web interface
   - `ws://YOUR_IP:8080` for WebSocket connections

3. Make sure your firewall allows connections on ports 5173 and 8080.

## Troubleshooting

### Port Already in Use

If you get a "port already in use" error:

```bash
# Change the port
PORT=3000 npm start
```

### WebSocket Connection Fails

1. Check that the WebSocket server is running (you should see the log message)
2. Verify the port (default 8080) is not blocked by firewall
3. For HTTPS sites, use `wss://` instead of `ws://`
4. Check browser console for connection errors

### Files Not Found (404)

1. Make sure you've run `npm run build` first
2. Check that the `dist` directory exists and contains files
3. Verify the file path in the URL matches the built files

## Development vs Production

- **Development**: Use `npm run dev` (Vite dev server) - includes hot reload, but no WebSocket server
- **Production**: Use `npm run start:prod` (Node.js server) - serves built files with WebSocket support

For development with WebSocket, you can run both:
1. Terminal 1: `npm run dev` (for frontend development)
2. Terminal 2: `node server.js` (for WebSocket server only, but you'll need to build first)

## Notes

- The server binds to `0.0.0.0` to accept connections from all network interfaces
- WebSocket messages are broadcast to all connected clients (except the sender)
- The server handles graceful shutdown on SIGTERM and SIGINT signals
- Static files are cached (except HTML files) for better performance
