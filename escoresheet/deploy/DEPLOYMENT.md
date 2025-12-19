# OpenVolley Subdomain Deployment Guide

This guide explains how to deploy the OpenVolley dashboards as separate subdomains on Railway.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         DNS (Cloudflare)                        │
│  *.openvolley.app → Railway custom domains                      │
└─────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────┬───────────┼───────────┬─────────────┐
        ▼             ▼           ▼           ▼             ▼
┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│    app    │ │  referee  │ │   bench   │ │ livescore │ │   roster  │
│  (main)   │ │           │ │           │ │           │ │           │
│ Static    │ │ Static    │ │ Static    │ │ Static    │ │ Static    │
└───────────┘ └───────────┘ └───────────┘ └───────────┘ └───────────┘
        │             │           │           │             │
        └─────────────┴───────────┼───────────┴─────────────┘
                                  ▼
                        ┌─────────────────┐
                        │  Backend (API)  │
                        │  WebSocket      │
                        │  Railway        │
                        └─────────────────┘
```

## Subdomains

| Subdomain | Purpose | Build Command |
|-----------|---------|---------------|
| `app.openvolley.app` | Main scoresheet (scorers) | `npm run build:app` |
| `referee.openvolley.app` | Referee dashboard | `npm run build:referee` |
| `bench.openvolley.app` | Team bench dashboard | `npm run build:bench` |
| `livescore.openvolley.app` | Live scoreboard display | `npm run build:livescore` |
| `roster.openvolley.app` | Roster PDF upload | `npm run build:roster` |

## Step 1: Build All Subdomains

From the `frontend` directory:

```bash
npm run build:subdomains
```

This creates:
- `dist-app/`
- `dist-referee/`
- `dist-bench/`
- `dist-livescore/`
- `dist-roster/`

## Step 2: Deploy to Railway

### Option A: Using Railway CLI (Recommended)

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`

For each subdomain, create a new Railway project:

```bash
# Example for referee subdomain
cd frontend
npm run build:referee
cd dist-referee
railway init  # Create new project: "openvolley-referee"
railway up    # Deploy
railway domain  # Add custom domain: referee.openvolley.app
```

### Option B: Using Railway Dashboard

1. Go to [railway.app](https://railway.app)
2. Create a new project for each subdomain
3. Connect your GitHub repo
4. Set the build command and root directory:
   - Root Directory: `escoresheet/frontend`
   - Build Command: `npm install && npm run build:referee`
   - Start Command: `npx serve dist-referee -s -l $PORT`
5. Add custom domain in Settings → Domains

### Railway Service Configuration

For each static site service:

**Build settings:**
- Builder: Nixpacks
- Build Command: `npm install && npm run build:SUBDOMAIN`
- Start Command: `npx serve dist-SUBDOMAIN -s -l $PORT`

**Environment Variables:**
- `VITE_BACKEND_URL`: `https://your-backend.railway.app`

## Step 3: DNS Configuration

In your DNS provider (e.g., Cloudflare):

1. Add CNAME records for each subdomain pointing to Railway:

```
app.openvolley.app      CNAME   your-app-service.railway.app
referee.openvolley.app  CNAME   your-referee-service.railway.app
bench.openvolley.app    CNAME   your-bench-service.railway.app
livescore.openvolley.app CNAME  your-livescore-service.railway.app
roster.openvolley.app   CNAME   your-roster-service.railway.app
```

2. If using Cloudflare, set SSL mode to "Full" or "Full (strict)"

## Step 4: Configure Backend CORS

The backend already allows these subdomains. Verify in `backend/server.js`:

```javascript
const ALLOWED_ORIGINS = [
  'https://openvolley.app',
  'https://app.openvolley.app',
  'https://referee.openvolley.app',
  'https://bench.openvolley.app',
  'https://livescore.openvolley.app',
  'https://roster.openvolley.app',
  // ...
]
```

## Environment Variables

Set these in Railway for frontend builds:

| Variable | Value | Description |
|----------|-------|-------------|
| `VITE_BACKEND_URL` | `https://api.openvolley.app` | Backend API URL |
| `VITE_SUPABASE_URL` | Your Supabase URL | For auth/data |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase key | For auth/data |

## Alternative: Cloudflare Pages

Cloudflare Pages is another excellent option for static sites:

1. Connect your GitHub repo
2. Build settings:
   - Build command: `cd escoresheet/frontend && npm install && npm run build:referee`
   - Build output: `escoresheet/frontend/dist-referee`
3. Add custom domain in Pages settings

Repeat for each subdomain with a different build command and output directory.

## Troubleshooting

### CORS Errors
- Check the Origin header in browser DevTools
- Verify the backend CORS configuration includes your subdomain
- Ensure you're using HTTPS in production

### WebSocket Connection Issues
- Verify `VITE_BACKEND_URL` points to the correct backend
- Check that WebSocket port is accessible (Railway uses same port for HTTP/WS)

### PWA Not Installing
- Each subdomain has its own manifest with correct `start_url: "/"`
- Service workers are scoped per subdomain
- Check manifest in DevTools → Application → Manifest

### SSL Certificate Issues
- Railway provides automatic SSL for custom domains
- Ensure DNS is pointing correctly
- Wait a few minutes for certificate provisioning
