# Deployment Guide

This app supports multiple deployment modes to fit different needs.

## Deployment Modes

### 1. **Standalone Mode (Current - GitHub Pages)** ✅
- **Frontend**: Static hosting (GitHub Pages, Netlify, Vercel)
- **Backend**: None (uses IndexedDB only)
- **Features**: Full scoresheet, offline-first, no real-time sync
- **Best for**: Single-device usage, offline environments

**Current Setup:**
```bash
# Already configured in .github/workflows/deploy.yml
# Deploys to: app.openvolley.app
# Automatic deployment on push to main branch
```

**Pros:**
- ✅ Free hosting
- ✅ Works completely offline
- ✅ No server maintenance
- ✅ Fast and reliable
- ✅ PWA with offline support

**Cons:**
- ❌ No real-time sync between devices
- ❌ No WebSocket for Referee/Bench views

---

### 2. **Hybrid Mode (PWA + Optional Backend)**
- **Frontend**: Static hosting with PWA
- **Backend**: Optional (Railway/Render free tier)
- **Features**: Works standalone OR with real-time sync if backend available
- **Best for**: Flexibility - works offline but syncs when online

**Setup:**

1. **Deploy Backend** (optional - only if you want real-time features):

   **Option A: Railway (Free tier)**
   ```bash
   cd backend
   railway login
   railway init
   railway up
   # Get your Railway URL (e.g., https://escoresheet-backend.railway.app)
   ```

   **Option B: Render (Free tier)**
   ```bash
   # Push backend folder to GitHub
   # Connect to Render.com
   # Deploy from GitHub
   # Get your Render URL (e.g., https://escoresheet.onrender.com)
   ```

2. **Configure Frontend** to use backend:
   ```bash
   cd frontend
   cp .env.example .env
   # Edit .env and set:
   VITE_BACKEND_URL=https://your-backend-url.railway.app
   ```

3. **Rebuild and deploy**:
   ```bash
   npm run build
   # Commit and push - GitHub Actions will deploy
   ```

**Pros:**
- ✅ Works offline (PWA)
- ✅ Real-time sync when online
- ✅ Free backend hosting
- ✅ Best of both worlds

**Cons:**
- ⚠️ Free tier backends sleep after inactivity (30s cold start)
- ⚠️ Need to manage two deployments

---

### 3. **Full Stack Mode (Development)**
- **Frontend + Backend**: Single server (current dev setup)
- **Features**: Full features, WebSocket, API routes
- **Best for**: Local development, Electron app

**Setup:**
```bash
cd frontend
npm run dev        # Frontend on :5173, WebSocket on :8080
# OR
npm run build
npm run start      # Production server serving everything
```

**Pros:**
- ✅ All features work
- ✅ Easy development
- ✅ Single deployment for Electron

**Cons:**
- ❌ Requires Node.js server (not static hosting)

---

## Current Configuration

### ✅ What's Already Working

1. **PWA Enabled** in dev and production (`vite.config.js`)
   - Service worker caches all assets
   - Works offline after first load
   - Network-first for API calls
   - Cache-first for static assets

2. **Smart Backend Detection** (`src/App.jsx`)
   - Detects GitHub Pages deployment
   - Skips API calls in standalone mode
   - No console errors in production

3. **Automatic GitHub Pages Deployment** (`.github/workflows/deploy.yml`)
   - Builds on every push to main
   - Deploys to app.openvolley.app
   - HTTPS enabled

### 📱 PWA Features

The app is now a Progressive Web App:

- **Install to home screen** (mobile/desktop)
- **Works offline** (after first load)
- **Auto-updates** when online
- **Smart caching** (network-first for API, cache-first for assets)
- **Background sync** (when implemented)

### 🔧 Testing PWA Locally

```bash
npm run dev
# Open http://localhost:5173
# Open DevTools > Application > Service Workers
# You should see service worker registered and active
```

---

## Recommended Deployment Strategy

### For Your Use Case (Volleyball Scoring):

**Option 1: Keep Current Setup (Standalone)** ✅ Currently Active
- ✅ GitHub Pages deployment
- ✅ No backend needed
- ✅ Works perfectly offline
- ✅ PWA with offline support
- ✅ Share matches via Supabase (already implemented)
- ✅ No console errors in production

**Option 2: Add Optional Backend** (Follow STEP_BY_STEP_DEPLOYMENT.md)
- Deploy backend to Railway (free, 500 hours/month)
- Real-time sync between Scoreboard ↔ Referee ↔ Bench
- Works offline locally (WiFi hotspot, no internet needed)
- Or works online (cloud relay for remote connections)
- Set `VITE_BACKEND_URL` in GitHub Secrets
- App works standalone BUT syncs when backend is available
- Best for tournaments (multiple courts with referee tablets)

**Quick Start for Backend**: See [STEP_BY_STEP_DEPLOYMENT.md](STEP_BY_STEP_DEPLOYMENT.md)

---

## Environment Variables

### Frontend (.env)
```bash
# Backend (optional)
VITE_BACKEND_URL=              # Leave empty for standalone mode

# Supabase (optional)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# PWA
VITE_APP_TITLE=Open eScoresheet
VITE_BASE_PATH=/

# Development
VITE_HTTPS=false               # Set to true for HTTPS in dev
```

### GitHub Secrets (for deployment)
```
VITE_SUPABASE_URL              # Already set
VITE_SUPABASE_ANON_KEY         # Already set
VITE_BACKEND_URL               # Add this if using separate backend
```

---

## Cost Comparison

| Mode | Frontend | Backend | Total Cost |
|------|----------|---------|------------|
| Standalone (current) | Free (GitHub Pages) | N/A | **$0/month** |
| Hybrid | Free (GitHub Pages) | Free (Railway/Render) | **$0/month** |
| Full Stack | $5-10/month (VPS) | Included | $5-10/month |

---

## Migration Steps (if you want to add backend)

1. **Test backend locally**:
   ```bash
   cd backend
   npm install
   npm start
   # Backend runs on http://localhost:8080
   ```

2. **Deploy backend to Railway**:
   ```bash
   railway login
   railway init
   railway up
   ```

3. **Update GitHub Secrets**:
   - Add `VITE_BACKEND_URL=https://your-app.railway.app`

4. **Update deploy workflow** (`.github/workflows/deploy.yml`):
   ```yaml
   env:
     VITE_BACKEND_URL: ${{ secrets.VITE_BACKEND_URL }}
   ```

5. **Push to trigger deployment**

---

## Troubleshooting

### Service Worker Not Updating
```bash
# Clear service worker cache
# DevTools > Application > Service Workers > Unregister
# Then hard reload (Ctrl+Shift+R)
```

### PWA Not Installing
```bash
# Check manifest
# DevTools > Application > Manifest
# Ensure favicon.png exists and is valid
```

### Backend Connection Failing
```bash
# Check CORS headers
# Backend must allow: Access-Control-Allow-Origin: *
# Check backend logs
```

---

## Next Steps

Current setup is **production-ready** for standalone mode. If you want real-time features:

1. Deploy backend to Railway (takes 5 minutes)
2. Add `VITE_BACKEND_URL` to GitHub Secrets
3. Push to redeploy

That's it! The app automatically detects the backend and enables real-time features.
