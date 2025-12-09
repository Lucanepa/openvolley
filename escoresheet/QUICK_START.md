# Quick Start Guide

## What Changed

### ✅ Fixed Production Console Errors
Your app no longer shows 404 errors in production (app.openvolley.app). The app now detects GitHub Pages deployment and skips server API calls.

### ✅ Enabled PWA in Development
Service worker now works in dev mode (`npm run dev`). You can test offline functionality locally.

### ✅ Created Optional Backend
New WebSocket server for real-time Scoreboard ↔ Referee ↔ Bench sync. **This is optional** - your app works perfectly without it.

---

## Current Status

**Production (app.openvolley.app)**:
- ✅ Deployed via GitHub Pages
- ✅ PWA with offline support
- ✅ No backend (standalone mode)
- ✅ No console errors
- ✅ Works completely offline

**You don't need to do anything!** It's already working perfectly.

---

## Optional: Add Real-Time Features

If you want Referee/Bench tablets to sync in real-time with Scoreboard:

### Quick Deploy to Railway (5 minutes)

```bash
# 1. Install Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Deploy backend
cd escoresheet/backend
railway init
railway up

# 4. Get your URL
railway open
# Copy URL (e.g., https://escoresheet-backend-production.up.railway.app)

# 5. Add to GitHub
# Go to: github.com/YOUR_USERNAME/openvolley/settings/secrets/actions
# Create secret: VITE_BACKEND_URL = your-railway-url

# 6. Push to deploy
git commit -am "Add Railway backend"
git push
```

Done! Your app now has real-time sync.

---

## How It Works

### Without Backend (Current)
```
Scoreboard (Tablet)
    ↓
IndexedDB (Local Storage)
```

**Works**: ✅ Offline
**Referee sync**: ❌ No

### With Backend (Optional)
```
Scoreboard → WebSocket Server ← Referee
    ↓              ↓
IndexedDB    (Railway Cloud)
```

**Works**: ✅ Offline + Online
**Referee sync**: ✅ Real-time

---

## Testing

### Test Current Setup

1. Visit: https://app.openvolley.app
2. Open DevTools → Console
3. Should see **no 404 errors** ✅

### Test PWA Locally

```bash
cd escoresheet/frontend
npm run dev
# Open http://localhost:5173
# DevTools → Application → Service Workers
# Should show "activated and is running"
```

### Test Offline Mode

1. Open app.openvolley.app
2. DevTools → Network → ☑️ Offline
3. App still works ✅

---

## Documentation

- **[STEP_BY_STEP_DEPLOYMENT.md](STEP_BY_STEP_DEPLOYMENT.md)** - Complete deployment guide
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Architecture overview
- **[backend/README.md](backend/README.md)** - Backend API documentation

---

## Questions?

### Do I need to deploy the backend?
**No!** Your app works perfectly without it. Only deploy if you want real-time Referee/Bench sync.

### Will it cost money?
**No!** Railway free tier includes 500 hours/month. More than enough.

### Can I use it offline?
**Yes!** The app works completely offline (with or without backend). PWA caches everything.

### What about Supabase?
**Already working!** Your app backs up matches to Supabase when internet is available. No changes needed.

### Will this break my current setup?
**No!** The backend is optional. If not deployed, the app works in standalone mode (current behavior).

---

## Summary

**Current Setup**: ✅ Production-ready, no changes needed

**Optional Enhancement**: Add WebSocket backend for real-time features

**Cost**: Free

**Time to deploy backend**: 5 minutes

**Offline support**: Always works offline (with or without backend)
