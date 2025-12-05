# Quick Setup Guide for Desktop & Mobile Apps

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd frontend
npm install
```

### 2. Desktop Apps (Electron)

**Development:**
```bash
npm run electron:dev
```

**Build for your platform:**
```bash
# Windows
npm run electron:build:win

# macOS  
npm run electron:build:mac

# Linux
npm run electron:build:linux
```

**Output:** Built apps will be in `dist-electron/` folder

### 3. Mobile Apps (Capacitor)

**First-time setup:**
```bash
# Initialize Capacitor
npx cap init

# Add platforms
npx cap add android
npx cap add ios  # macOS only
```

**Build and open:**
```bash
# Build web app
npm run build

# Sync to native projects
npx cap sync

# Open in IDE
npm run cap:open:android  # or cap:open:ios
```

## 📝 Notes

- **Icons:** Place app icons in `electron/` folder (see `electron/README.md`)
- **Desktop UI:** Electron apps use your existing PWA UI - no changes needed!
- **Mobile UI:** Capacitor wraps your PWA - works as-is on mobile
- **Offline:** All versions work offline with IndexedDB
- **Supabase:** Sync works when online in all versions

## 🔍 Debugging Supabase

Check browser console for:
- `🔍 Supabase Client Initialization:` - Shows if env vars are loaded
- `✅ Supabase client created successfully` - Client is ready
- `⚠️ Supabase not configured` - Missing env vars

In GitHub Actions, check the build logs for:
- `🔍 Environment check:` - Shows if secrets are set (without exposing values)
