# Cloudflare Pages Configuration

## Build Settings

To fix the "build output directory contains links to files that can't be accessed" error, configure Cloudflare Pages with the following settings:

### Build Configuration

1. **Build command**: `npm run build`
2. **Build output directory**: `dist`
3. **Root directory**: `/` (leave empty or use root)

### Steps to Configure

1. Go to Cloudflare Dashboard > Pages > Your Project
2. Navigate to **Settings** > **Builds & Deployments**
3. Configure the build settings:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: Leave empty (or set to `/`)

### What Changed

- Added `node_modules/` to `.gitignore` to prevent it from being committed
- Created `build.sh` script that copies only static files to `dist/` directory
- Added `npm run build` script to `package.json`
- The build output (`dist/`) contains only the files needed for deployment (no symlinks)

### Notes

- Dependencies (animejs, bootstrap-icons) are loaded from CDN, so `node_modules` is not needed for deployment
- The build script copies: HTML, CSS, JS, images, favicon, CNAME, and assets directory
- All symlinks from `node_modules` are excluded from the build output
