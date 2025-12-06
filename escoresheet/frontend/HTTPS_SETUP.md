# HTTPS Setup Guide

This guide explains how to enable HTTPS for both development and production servers.

## Development (Vite Dev Server)

### Option 1: Auto-generated Self-Signed Certificate (Easiest)

Vite can automatically generate a self-signed certificate:

```bash
npm run dev:https
```

Your browser will show a security warning - click "Advanced" and "Proceed to localhost" to continue.

### Option 2: Custom Self-Signed Certificate

1. Generate certificates:
```bash
npm run generate-certs
```

This creates:
- `localhost.pem` (certificate)
- `localhost-key.pem` (private key)

2. Start dev server with HTTPS:
```bash
npm run dev:https
```

### Accessing the Dev Server

- **HTTPS**: https://localhost:5173
- **HTTP**: http://localhost:5173 (if you run `npm run dev` without HTTPS)

## Production Server

### Option 1: Self-Signed Certificate (Development/Testing)

1. Generate certificates:
```bash
npm run generate-certs
```

2. Start production server with HTTPS:
```bash
npm run start:https
```

Or build and start:
```bash
npm run start:prod:https
```

### Option 2: Real SSL Certificates (Production)

For production, use certificates from a trusted CA (Let's Encrypt, etc.):

1. Place your certificates in the frontend directory:
   - `localhost.pem` (or set `SSL_CERT_PATH` env var)
   - `localhost-key.pem` (or set `SSL_KEY_PATH` env var)

2. Start with HTTPS:
```bash
HTTPS=true SSL_CERT_PATH=/path/to/cert.pem SSL_KEY_PATH=/path/to/key.pem npm start
```

### Environment Variables

- `HTTPS=true` or `USE_HTTPS=true` - Enable HTTPS
- `SSL_CERT_PATH` - Path to SSL certificate file (default: `./localhost.pem`)
- `SSL_KEY_PATH` - Path to SSL private key file (default: `./localhost-key.pem`)
- `PORT` - HTTP/HTTPS server port (default: 5173)
- `WS_PORT` - WebSocket server port (default: 8080)

### WebSocket Connections

When HTTPS is enabled:
- Use `wss://` (secure WebSocket) instead of `ws://`
- Example: `wss://localhost:8080` or `wss://your-domain.com:8080`

The `connectionManager.js` automatically detects the protocol and uses the appropriate WebSocket scheme.

## Using Let's Encrypt (Production)

For production with a real domain:

1. Install certbot:
```bash
# Ubuntu/Debian
sudo apt-get install certbot

# Mac
brew install certbot
```

2. Generate certificates:
```bash
sudo certbot certonly --standalone -d your-domain.com
```

3. Certificates are typically stored at:
   - `/etc/letsencrypt/live/your-domain.com/fullchain.pem`
   - `/etc/letsencrypt/live/your-domain.com/privkey.pem`

4. Start server with Let's Encrypt certificates:
```bash
HTTPS=true \
SSL_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem \
SSL_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem \
npm start
```

## Troubleshooting

### Browser Security Warning

Self-signed certificates will show a security warning. This is normal for development. Click "Advanced" → "Proceed to localhost" (or your domain).

### Certificate Not Found

If you see "certificates not found" error:
1. Make sure you've run `npm run generate-certs`
2. Check that `localhost.pem` and `localhost-key.pem` exist in the frontend directory
3. Verify file permissions (should be readable)

### Port Already in Use

If port 5173 is already in use:
```bash
PORT=3000 npm start
```

### WebSocket Connection Fails with HTTPS

When using HTTPS, make sure to:
1. Use `wss://` instead of `ws://` in connection URLs
2. The WebSocket server port (default 8080) should be accessible
3. Check firewall settings for the WebSocket port

## Security Notes

- **Self-signed certificates** are for development only
- **Production** should use certificates from a trusted CA (Let's Encrypt, etc.)
- Never commit certificate files to git (they're in `.gitignore`)
- Keep private keys secure and never share them

## Quick Reference

```bash
# Development with HTTPS (auto-generated cert)
npm run dev:https

# Development with HTTPS (custom cert)
npm run generate-certs
npm run dev:https

# Production with HTTPS (self-signed)
npm run generate-certs
npm run start:prod:https

# Production with HTTPS (real certs)
HTTPS=true SSL_CERT_PATH=/path/to/cert.pem SSL_KEY_PATH=/path/to/key.pem npm run start:prod
```
