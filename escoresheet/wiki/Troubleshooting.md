# Troubleshooting

## Development Issues

### Build Failures

#### "Error: self-signed certificate"

Regenerate the local HTTPS certificates:

```bash
cd escoresheet/frontend
npm run generate-certs
```

#### "Electron failed to install"

Clear `node_modules` and reinstall:

```bash
cd escoresheet/frontend
rm -rf node_modules
npm install
```

#### "canvas" native dependency errors

The `canvas` package is not needed for browser-based PDF generation. If it causes build issues (especially on CI), remove it:

```bash
rm -rf node_modules/canvas
```

The GitHub Actions release workflow already handles this automatically.

#### Port 5173 already in use

Another process is using the dev server port. Find and stop it:

```bash
# Linux/macOS
lsof -ti:5173 | xargs kill

# Windows
netstat -ano | findstr :5173
taskkill /PID <PID> /F
```

Or Vite will automatically try the next available port.

## App Issues

### Data not syncing to cloud

- Check the connection status indicator in the app
- Open browser DevTools (F12) and check the Console for Supabase or WebSocket errors
- Verify that `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set correctly
- The sync queue processes in order (match > set > event). If a match sync fails, sets and events will also be blocked

### WebSocket connection not working

- **Local**: Make sure the backend server is running and the device can reach it on the network
- **Cloud**: Verify `VITE_BACKEND_URL` is set to the correct Railway/Render URL
- **Protocol**: Use `ws://` for HTTP connections and `wss://` for HTTPS. Railway requires `wss://`
- **CORS**: The backend must include your origin in the allowed list. Cloud mode accepts `*.openvolley.app` and localhost. Local mode accepts all origins

### PDF generation fails

- Make sure all required fields are filled in (teams, players, match details)
- Check if a popup blocker is preventing the PDF from opening
- Open browser DevTools (F12) and check for jsPDF errors in the Console
- Try a different browser if the issue persists

### PWA not installing

- The app must be served over HTTPS (or localhost)
- Check DevTools > Application > Manifest for errors
- Check DevTools > Application > Service Workers for registration status
- Each subdomain has its own manifest and service worker
- Try clearing the service worker and reloading

### App shows an outdated version

- Look for an update banner in the app and accept the update
- If no banner appears, clear the service worker cache:
  1. Open DevTools > Application > Service Workers
  2. Click "Unregister" on the service worker
  3. Hard refresh the page (Ctrl+Shift+R or Cmd+Shift+R)

### Match data lost after clearing browser data

- IndexedDB data is stored in your browser. Clearing site data or browser data will delete it
- If the match was synced to Supabase before clearing, it can be recovered from the cloud
- To prevent data loss, make sure cloud sync is working before clearing browser data

## Deployment Issues

### Electron build fails on CI

- Make sure `ELECTRON=true` is set as an environment variable
- The `canvas` native dependency may need to be removed (see "canvas" section above)
- The CI workflow uses Node.js 22

### Cloudflare Pages: build fails

- Verify the build command includes navigating to the frontend directory: `cd escoresheet/frontend && npm install && npm run build`
- Check that the build output path matches: `escoresheet/frontend/dist`
- Environment variables must be configured in the Cloudflare Pages dashboard

### Railway: "EADDRINUSE"

Railway is trying to deploy the whole repo instead of just the backend. Set **Root Directory** to `escoresheet/backend` in the Railway dashboard under Settings.

### Railway: deployment stuck or failing

1. Check logs: `railway logs`
2. Make sure `package.json` exists in the backend folder
3. Try redeploying: `cd escoresheet/backend && railway up`

## Getting Help

If you encounter an issue not covered here:

1. Check the browser console (F12) for error messages
2. Note your browser version and app version (shown in app settings)
3. Open an issue on [GitHub](https://github.com/lucacanepa/openvolley/issues) with steps to reproduce the problem
