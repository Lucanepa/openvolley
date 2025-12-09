# Railway Deployment Quick Guide

## Prerequisites

- Railway account (free): https://railway.app
- Railway CLI installed: `npm install -g @railway/cli`
- Your backend code in `escoresheet/backend/`

---

## Option 1: Deploy from CLI (Recommended)

### Step 1: Login

```bash
railway login
```

Browser will open → Login with GitHub → Authorize

### Step 2: Navigate to Backend

```bash
cd escoresheet/backend
```

### Step 3: Initialize Project

```bash
railway init
```

Answer prompts:
- **Create new project?** Yes
- **Project name:** `escoresheet-backend` (or your choice)
- **Environment:** `production`

### Step 4: Deploy

```bash
railway up
```

Wait 30-60 seconds for deployment.

### Step 5: Get URL

```bash
railway open
```

Dashboard opens → Copy your deployment URL (e.g., `https://escoresheet-backend-production.up.railway.app`)

---

## Option 2: Deploy from GitHub

### Step 1: Push Code to GitHub

```bash
git add -A
git commit -m "Add backend"
git push
```

### Step 2: Connect Railway to GitHub

1. Go to https://railway.app/dashboard
2. Click **New Project**
3. Select **Deploy from GitHub repo**
4. Choose your repository
5. **IMPORTANT**: Set **Root Directory** to `escoresheet/backend`
6. Click **Deploy**

### Step 3: Get URL

Once deployed, click on your service → Settings → Generate Domain

---

## Fix Deployment Issues

### Error: "EADDRINUSE: address already in use"

**Cause**: Railway is trying to deploy the entire repo, not just backend folder.

**Fix**:

1. In Railway dashboard → Your service → Settings
2. **Root Directory**: `escoresheet/backend`
3. Redeploy

### Error: "No package.json found"

**Cause**: Railway can't find the backend folder.

**Fix**: Make sure you ran `railway init` from inside `escoresheet/backend/`

### Deployment stuck or failing

1. Check logs:
   ```bash
   railway logs
   ```

2. Verify files exist:
   ```bash
   ls escoresheet/backend/
   # Should show: package.json, server.js, etc.
   ```

3. Redeploy:
   ```bash
   railway up --detach
   ```

---

## Verify Deployment

### Test Health Endpoint

```bash
curl https://your-railway-url.railway.app/health
```

Should return:
```json
{
  "status": "healthy",
  "mode": "cloud",
  "uptime": 123.45,
  "connections": 0,
  "activeRooms": 0
}
```

### Test WebSocket

Open browser console:

```javascript
const ws = new WebSocket('wss://your-railway-url.railway.app')

ws.onopen = () => console.log('Connected!')
ws.onmessage = (e) => console.log('Message:', e.data)
```

Should see:
```
Connected!
Message: {"type":"connected","clientId":"abc123",...}
```

---

## Configure Frontend

### Step 1: Add to GitHub Secrets

1. Go to: `https://github.com/YOUR_USERNAME/openvolley/settings/secrets/actions`
2. Click **New repository secret**
3. **Name**: `VITE_BACKEND_URL`
4. **Value**: `https://your-railway-url.railway.app`
5. Click **Add secret**

### Step 2: Update Deployment Workflow

Your workflow already includes this variable, so just push to deploy:

```bash
git push
```

GitHub Actions will automatically build with your Railway backend URL.

---

## Monitor Deployment

### View Logs

```bash
railway logs --tail
```

### Check Status

```bash
railway status
```

### Open Dashboard

```bash
railway open
```

---

## Environment Variables

Railway auto-detects the PORT variable. No configuration needed.

Optional variables:
- `NODE_ENV=production` (auto-set by Railway)
- `RAILWAY_ENVIRONMENT=production` (auto-set by Railway)

---

## Free Tier Limits

- **500 execution hours/month**
- **$5 credit/month**
- **512MB RAM**
- **1GB disk**
- Auto-sleeps after 1 hour inactivity (wakes instantly)

Perfect for hobby projects and light usage.

---

## Next Steps

1. ✅ Deploy backend: `railway up`
2. ✅ Get URL: `railway open`
3. ✅ Add to GitHub Secrets: `VITE_BACKEND_URL`
4. ✅ Push to GitHub: `git push`
5. ✅ Test: Visit app.openvolley.app

---

## Support

**Railway Docs**: https://docs.railway.app

**Common Commands**:
```bash
railway login          # Login to Railway
railway init           # Initialize new project
railway up             # Deploy current directory
railway logs           # View logs
railway logs --tail    # Stream logs
railway open           # Open dashboard
railway status         # Check deployment status
railway link           # Link to existing project
railway unlink         # Unlink from project
```

**Troubleshooting**:
- Logs not showing? `railway logs --tail`
- Deployment failing? Check Root Directory in Settings
- WebSocket not connecting? Verify WSS protocol (not WS)
- 404 on health check? Backend may still be starting (wait 30s)

---

## Cost Estimates

### Free Tier (Current)
- **Cost**: $0/month
- **Hours**: 500 exec hours/month
- **Good for**: Development, light production use

### Hobby Tier ($5/month)
- **Cost**: $5/month
- **Hours**: Unlimited
- **No sleep**: Server always on
- **Good for**: Production use, tournaments

Most users will be fine with free tier.
