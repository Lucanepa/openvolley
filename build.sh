#!/bin/bash
# Build script for Cloudflare Pages deployment
# Copies only the static files needed for the landing page

set -e

OUTPUT_DIR="dist"

# Create output directory
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

# Copy static files
cp index.html "$OUTPUT_DIR/"
cp landing.css "$OUTPUT_DIR/"
cp landing.js "$OUTPUT_DIR/"
cp favicon.ico "$OUTPUT_DIR/"
cp CNAME "$OUTPUT_DIR/" 2>/dev/null || true

# Copy images
cp *.png "$OUTPUT_DIR/" 2>/dev/null || true
cp *.ico "$OUTPUT_DIR/" 2>/dev/null || true

# Copy assets directory if it exists
if [ -d "assets" ]; then
  cp -r assets "$OUTPUT_DIR/"
fi

echo "Build complete! Output directory: $OUTPUT_DIR"
