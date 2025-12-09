# Step-by-Step Deployment Guide

Complete guide to deploy eScoresheet with optional WebSocket backend.

## Overview

Your app has **three deployment modes**:

1. **Standalone** (Current) - No backend, works completely offline ✅
2. **Local Network** - Backend on local WiFi, no internet needed
3. **Cloud Relay** - Backend on Railway, works from anywhere with internet

All modes support PWA with offline capabilities.

---

## Option 1: Keep Current Setup (No Changes Needed) ✅

**What you have now:**
- GitHub Pages hosting (free)
- PWA with offline support
- No backend server
- No console errors in production
- Works completely offline after first load

**When to use:**
- Single scorekeeper device
- No referee/bench tablets
- Tournament with paper-based referee sheets

**Status**: ✅ Already deployed and working

---

## Option 2: Local Network (WiFi Hotspot)

**What you get:**
- Scoreboard ↔ Referee/Bench real-time sync
- Works without internet
- Use tablet hotspot or gymnasium WiFi
- Free

### Prerequisites

- Laptop or second tablet to run backend server
- All devices on same WiFi network

### Step 1: Run Backend Locally

```bash
# On your laptop
cd escoresheet/backend
npm install
npm start
```

Server starts on port 8080.

### Step 2: Get Local IP Address

**On Windows**:
```bash
ipconfig
# Look for IPv4 Address (e.g., 192.168.1.100)
```

**On Mac/Linux**:
```bash
ifconfig
# or
ip addr show
# Look for inet address
```

### Step 3: Configure Devices

On Scoreboard tablet, open Settings → Add local server:
```
http://192.168.1.100:8080
```

On Referee tablets, connect to same server.

### Done!

Devices now sync in real-time over local WiFi.

**No internet needed!**

---

## Option 3: Cloud Relay (Railway.app)

**What you get:**
- Referee tablets can connect from anywhere
- Multiple courts in different locations
- No laptop needed on-site
- Free tier (500 hours/month)

### Prerequisites

- GitHub account
- Internet connection

### Step 1: Install Railway CLI

```bash
npm install -g @railway/cli
```

### Step 2: Login to Railway

```bash
railway login
```

Browser opens → Login with GitHub → Authorize

### Step 3: Deploy Backend

```bash
cd escoresheet/backend
railway init
```

Answer prompts:
- **Create new project**: Yes
- **Project name**: `escoresheet-backend`
- **Environment**: `production`

**IMPORTANT**: Railway needs to know to deploy from the backend folder only.

Option A - Deploy via Railway CLI (Recommended):
```bash
railway up
```

Option B - Deploy via GitHub (if railway up doesn't work):
1. Link to your GitHub repo:
   ```bash
   railway link
   ```
2. In Railway dashboard, set **Root Directory** to `escoresheet/backend`
3. Deploy:
   ```bash
   git push
   ```

Wait for deployment (30-60 seconds).

### Step 4: Get Your Backend URL

```bash
railway open
```

Dashboard opens. Look for deployment URL:
```
https://escoresheet-backend-production.up.railway.app
```

**Copy this URL!**

### Step 5: Configure Frontend

```bash
cd ../frontend
cp .env.example .env
```

Edit `.env`:
```env
VITE_BACKEND_URL=https://escoresheet-backend-production.up.railway.app
```

### Step 6: Add to GitHub Secrets

Go to: `https://github.com/YOUR_USERNAME/openvolley/settings/secrets/actions`

Click **New repository secret**:
- **Name**: `VITE_BACKEND_URL`
- **Value**: `https://escoresheet-backend-production.up.railway.app`

### Step 7: Trigger Deployment

```bash
git add .
git commit -m "Add Railway backend URL"
git push
```

GitHub Actions automatically deploys to app.openvolley.app.

### Done!

Your app now has cloud relay for real-time features!

**Monitor your deployment**:
```bash
railway logs --tail
```

---

## Testing the Setup

### Test 1: Backend Health

Open browser:
```
https://your-backend-url.railway.app/health
```

Should see:
```json
{
  "status": "healthy",
  "mode": "cloud",
  "connections": 0,
  "activeRooms": 0
}
```

### Test 2: Frontend Connection

1. Open app.openvolley.app
2. Open DevTools → Network → WS
3. Start a match
4. Should see WebSocket connection to Railway

### Test 3: Referee Sync

1. Open Scoreboard on one device
2. Open Referee view on another device
3. Enter same match PIN
4. Score points on Scoreboard
5. Referee view updates in real-time ✅

---

## Architecture Diagram

### Without Backend (Current)
```
┌──────────────┐
│  Scoreboard  │
│   (Tablet)   │
│              │
│  IndexedDB   │  ← Local storage only
└──────────────┘
```

### With Local Backend
```
┌──────────────┐         ┌──────────────┐
│  Scoreboard  │  WiFi   │   Backend    │
│   (Tablet)   │◄───────►│  (Laptop)    │
└──────────────┘         └──────┬───────┘
                                │
                        ┌───────┴───────┐
                        │               │
                 ┌──────▼────┐   ┌─────▼─────┐
                 │  Referee  │   │   Bench   │
                 │  (Tablet) │   │  (Tablet) │
                 └───────────┘   └───────────┘
```

### With Cloud Backend
```
┌──────────────┐                    ┌──────────────┐
│  Scoreboard  │   Internet         │   Railway    │
│   (Tablet)   │◄──────────────────►│   Backend    │
└──────────────┘                    └──────┬───────┘
                                           │
                                   ┌───────┴───────┐
                               Internet        Internet
                           ┌───────┴───────────────┴──────┐
                           │                              │
                    ┌──────▼────┐                  ┌──────▼────┐
                    │  Referee  │                  │   Bench   │
                    │  (Tablet) │                  │  (Tablet) │
                    └───────────┘                  └───────────┘
```

### Hybrid (Best)
```
App tries connections in order:
1. Local network (ws://192.168.1.100:8080)  ← Fastest
2. Cloud relay (wss://railway.app)           ← Fallback
3. Offline mode (IndexedDB only)             ← Always works
```

---

## Supabase Integration (Backup & Storage)

Your app already has Supabase configured for:
- Match backup (when internet available)
- Match sharing between tournaments
- Historical data

**How it works:**

```
                    Online Mode
┌────────────────────────────────────────────┐
│                                            │
│  Scoreboard → IndexedDB (Primary)          │
│       ↓                                    │
│  Background sync to Supabase (Backup)      │
│                                            │
└────────────────────────────────────────────┘

                   Offline Mode
┌────────────────────────────────────────────┐
│                                            │
│  Scoreboard → IndexedDB (Only)             │
│       ↓                                    │
│  Sync queue (pending uploads)              │
│       ↓                                    │
│  Syncs when internet returns               │
│                                            │
└────────────────────────────────────────────┘
```

**No changes needed** - Already implemented in `useSyncQueue` hook!

---

## Cost Breakdown

| Component | Service | Cost |
|-----------|---------|------|
| Frontend | GitHub Pages | **Free** |
| PWA | Built-in | **Free** |
| Database | IndexedDB (local) | **Free** |
| Cloud DB | Supabase (free tier) | **Free** |
| Backend | Railway (500h/month) | **Free** |
| **Total** | | **$0/month** |

**Upgrade costs (if needed):**
- Railway Pro: $5/month (no sleep, more hours)
- Supabase Pro: $25/month (more storage)

---

## Recommended Deployment Strategy

### For Small Tournaments (1-2 courts)
**Use**: Standalone or Local Network
- No backend needed
- Works completely offline
- Share matches via Supabase if internet available

### For Medium Tournaments (3-5 courts)
**Use**: Local Network + Cloud Fallback
- Run backend on tournament laptop (local)
- Also deploy to Railway (cloud backup)
- App tries local first, falls back to cloud

### For Large Tournaments (6+ courts)
**Use**: Cloud Relay
- Deploy backend to Railway
- All courts connect to cloud
- Centralized monitoring

---

## Troubleshooting

### Backend not connecting

1. **Check backend is running**:
   ```bash
   curl https://your-backend-url.railway.app/health
   ```

2. **Check frontend config**:
   ```bash
   # In browser console
   console.log(import.meta.env.VITE_BACKEND_URL)
   ```

3. **Check Railway logs**:
   ```bash
   railway logs --tail
   ```

### WebSocket connection fails

1. **Check protocol**:
   - HTTPS app needs WSS backend
   - HTTP app needs WS backend

2. **Check firewall**:
   - Port 8080 must be open
   - Railway handles this automatically

3. **Check CORS**:
   - Backend has `Access-Control-Allow-Origin: *`
   - Already configured in `server.js`

### PWA not updating

1. **Clear service worker**:
   - DevTools → Application → Service Workers
   - Click "Unregister"
   - Hard reload (Ctrl+Shift+R)

2. **Check manifest**:
   - DevTools → Application → Manifest
   - Verify favicon.png exists

### Matches not syncing

1. **Check WebSocket connection**:
   - DevTools → Network → WS
   - Should show connected WebSocket

2. **Check match room**:
   - Scoreboard and Referee must use same match ID/PIN

3. **Check backend logs**:
   ```bash
   railway logs --tail
   ```

---

## Next Steps

Choose your deployment:

### Keep Current Setup
✅ Already done - nothing to do!

### Add Local Backend
1. `cd escoresheet/backend && npm install`
2. `npm start`
3. Note your local IP
4. Configure tablets

### Add Cloud Backend
1. `npm install -g @railway/cli`
2. `railway login`
3. `cd escoresheet/backend && railway init`
4. `railway up`
5. Copy URL → Add to GitHub Secrets
6. Push to deploy

---

## Support

**Documentation**:
- [Backend README](backend/README.md)
- [Deployment Overview](DEPLOYMENT.md)
- [Supabase Setup](SUPABASE_SETUP.md)

**Testing**:
- Backend: `http://localhost:8080/health`
- Frontend: `http://localhost:5173` (dev)
- Production: `https://app.openvolley.app`

**Monitoring**:
- Railway: `railway logs --tail`
- GitHub Actions: Commit → Actions tab
- PWA: DevTools → Application

**Common Commands**:
```bash
# Start dev server (frontend)
cd escoresheet/frontend && npm run dev

# Start backend (local)
cd escoresheet/backend && npm start

# Deploy backend (Railway)
cd escoresheet/backend && railway up

# View Railway logs
railway logs --tail

# Build production
cd escoresheet/frontend && npm run build
```

---

## Summary

Your app now supports:

✅ **Offline-first PWA** - Always works
✅ **Standalone mode** - No server needed (current)
✅ **Local network** - WiFi sync, no internet
✅ **Cloud relay** - Internet-based sync (optional)
✅ **Supabase backup** - Cloud storage (optional)

**All modes work!** Choose what fits your needs.

Most users can stick with **standalone mode** (current setup) and only deploy backend when needed for real-time referee/bench features.
