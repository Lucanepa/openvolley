# eScoresheet WebSocket Backend

Optional relay server for real-time communication between Scoreboard, Referee, and Bench tablets.

## Features

- **Match Rooms**: Isolated communication channels per match
- **Real-time Sync**: WebSocket-based instant updates
- **Offline-first**: App works without this server using IndexedDB
- **Dual Mode**:
  - Local network only (WiFi hotspot, no internet needed)
  - Cloud relay (for remote referee/bench connections)

## Architecture

```
Scoreboard (Tablet 1)
    ↓
WebSocket Server (This backend)
    ↓
Referee (Tablet 2) + Bench (Tablet 3)
```

## Quick Start

### Local Development

```bash
npm install
npm start
```

Server runs on `http://localhost:8080`

### Deploy to Railway (Free Tier)

1. **Install Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Login to Railway**:
   ```bash
   railway login
   ```

3. **Initialize project**:
   ```bash
   railway init
   # Follow prompts to create new project
   ```

4. **Deploy**:
   ```bash
   railway up
   ```

5. **Get your URL**:
   ```bash
   railway open
   # Or check dashboard for URL
   ```

6. **Copy your URL** (e.g., `https://escoresheet-backend-production.up.railway.app`)

### Configure Frontend

1. **Create `.env` in frontend folder**:
   ```bash
   cd ../frontend
   cp .env.example .env
   ```

2. **Edit `.env` and add**:
   ```env
   VITE_BACKEND_URL=https://your-railway-url.railway.app
   ```

3. **Rebuild frontend**:
   ```bash
   npm run build
   ```

That's it! The app will now use your Railway backend for real-time sync.

## Deployment Options

### Option 1: Local Network Only (No Internet Needed)

**Use Case**: Tablet hotspot, gymnasium WiFi, no internet

**Setup**:
1. Run backend on a laptop connected to same WiFi
2. Get laptop's local IP (e.g., `192.168.1.100`)
3. Configure frontend:
   ```env
   VITE_BACKEND_URL=http://192.168.1.100:8080
   ```

**Pros**:
- ✅ Works without internet
- ✅ Low latency
- ✅ Free

**Cons**:
- ❌ Need laptop/server on-site

### Option 2: Railway Cloud (Internet Required)

**Use Case**: Remote referee, multiple courts in different locations

**Setup**: Follow Railway deployment steps above

**Pros**:
- ✅ No on-site server needed
- ✅ Works from anywhere
- ✅ Free tier (500 hours/month)

**Cons**:
- ⚠️ Requires internet
- ⚠️ Slightly higher latency

### Option 3: Hybrid (Best of Both)

**Use Case**: Primary local network, cloud fallback

**Setup**:
1. Deploy to Railway (cloud backup)
2. Also run locally when available
3. App tries local first, falls back to cloud

Frontend automatically detects and uses available server.

## Testing

### Test Locally

```bash
npm start
```

Open browser: `http://localhost:8080/health`

Should see:
```json
{
  "status": "healthy",
  "mode": "local",
  "uptime": 123.45,
  "connections": 0,
  "activeRooms": 0
}
```

### Test WebSocket

Use a WebSocket client or browser console:

```javascript
const ws = new WebSocket('ws://localhost:8080')

ws.onopen = () => {
  console.log('Connected!')

  // Join a match room
  ws.send(JSON.stringify({
    type: 'join_match',
    matchId: 'test-match-123',
    role: 'referee'
  }))
}

ws.onmessage = (event) => {
  console.log('Received:', JSON.parse(event.data))
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `8080` |
| `RAILWAY_ENVIRONMENT` | Auto-set by Railway | - |
| `RENDER` | Auto-set by Render | - |

## API Endpoints

### `GET /health`
Health check

Response:
```json
{
  "status": "healthy",
  "mode": "local|cloud",
  "uptime": 123.45,
  "connections": 2,
  "activeRooms": 1
}
```

### `GET /api/server/status`
Detailed server status

Response:
```json
{
  "status": "online",
  "mode": "local|cloud",
  "wsPort": 8080,
  "connections": 2,
  "matches": 1,
  "rooms": 1,
  "uptime": 123.45
}
```

### `GET /api/match/list`
List active matches (ephemeral)

Response:
```json
[
  {
    "matchId": "abc123",
    "data": {...},
    "updatedAt": "2024-01-01T12:00:00Z",
    "updatedBy": "client123"
  }
]
```

## WebSocket Protocol

### Client → Server

#### Join Match
```json
{
  "type": "join_match",
  "matchId": "abc123",
  "role": "scoreboard|referee|bench"
}
```

#### Send Match Update (Scoreboard only)
```json
{
  "type": "match_update",
  "matchId": "abc123",
  "data": {...full match state...}
}
```

#### Send Action (Scoreboard only)
```json
{
  "type": "action",
  "matchId": "abc123",
  "action": {
    "type": "timeout|substitution|...",
    ...action data...
  }
}
```

#### Leave Match
```json
{
  "type": "leave_match"
}
```

#### Ping (Heartbeat)
```json
{
  "type": "ping"
}
```

### Server → Client

#### Connection Confirmed
```json
{
  "type": "connected",
  "clientId": "xyz789",
  "mode": "local|cloud",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

#### Joined Match
```json
{
  "type": "joined_match",
  "matchId": "abc123",
  "role": "referee",
  "roomSize": 2
}
```

#### Match Update
```json
{
  "type": "match_update",
  "matchId": "abc123",
  "data": {...match state...},
  "timestamp": "2024-01-01T12:00:00Z"
}
```

#### Action Broadcast
```json
{
  "type": "action",
  "matchId": "abc123",
  "action": {...action data...},
  "timestamp": "2024-01-01T12:00:00Z",
  "from": "client123"
}
```

#### Client Joined/Left
```json
{
  "type": "client_joined|client_left",
  "clientId": "xyz789",
  "role": "referee",
  "roomSize": 3
}
```

#### Error
```json
{
  "type": "error",
  "message": "Error description"
}
```

#### Pong (Heartbeat Response)
```json
{
  "type": "pong",
  "timestamp": 1234567890
}
```

## Monitoring

### Railway

```bash
# View logs
railway logs

# Check status
railway status

# Open dashboard
railway open
```

### Local

Server logs are printed to console with emojis for easy monitoring:
- ✅ Connection established
- 🎯 Client joined match
- 📤 Match update broadcasted
- ⚡ Action broadcasted
- ❌ Client disconnected
- ❓ Unknown message type

## Cost

### Railway Free Tier
- **500 execution hours/month**
- **$5 credit/month**
- Perfect for hobby projects
- Sleeps after 1 hour of inactivity (wakes instantly)

### Render Free Tier
- **750 hours/month**
- Sleeps after 15 minutes (30s cold start)
- Alternative option

### Self-hosted
- Run on any server/laptop
- Completely free
- Full control

## Troubleshooting

### Railway: "EADDRINUSE: address already in use"

**Problem**: Railway is trying to deploy the entire repo including frontend.

**Solution**: Configure Railway to use backend folder only:

1. In Railway dashboard → Settings → **Root Directory**: `escoresheet/backend`
2. Redeploy

Or use `railway up` from the `backend` folder directly.

### Connection refused
- Check firewall settings
- Ensure port 8080 is open
- Verify server is running

### WebSocket connection fails
- Check URL protocol (`ws://` for HTTP, `wss://` for HTTPS)
- Railway requires `wss://` (auto-configured)
- Local dev uses `ws://`

### High latency
- Use local network mode for best performance
- Cloud mode adds ~50-200ms latency

### Server crashes
- Check Railway logs: `railway logs`
- Memory limit: 512MB on free tier
- Increase if needed (paid tier)

### Railway deployment fails

1. Check logs: `railway logs`
2. Verify `package.json` exists in backend folder
3. Ensure Root Directory is set to `escoresheet/backend`
4. Try deploying from backend folder: `cd escoresheet/backend && railway up`

## Next Steps

1. **Deploy to Railway**: `railway up`
2. **Get your URL**: Check Railway dashboard
3. **Configure frontend**: Add `VITE_BACKEND_URL` to `.env`
4. **Test**: Start a match, connect referee
5. **Monitor**: Check Railway logs

## Support

For issues:
- Check logs: `railway logs`
- Test locally first: `npm start`
- Verify WebSocket connection in browser DevTools
