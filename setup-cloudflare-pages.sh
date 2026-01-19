#!/bin/bash
# Cloudflare Pages setup script for remaining OpenVolley subdomains
# Run: bash setup-cloudflare-pages.sh

# Environment variables (these are public keys, safe to have here)
VITE_SUPABASE_URL="https://tjnbwwjstxehwhxnvxyy.supabase.co"
VITE_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqbmJ3d2pzdHhlaHdoeG52eHl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIyNjY3MTksImV4cCI6MjA3Nzg0MjcxOX0.r9-9FBcyWZhRVRZzG0RZ9nMWnF5KaWrWxbWmypGuxhQ"
VITE_BACKEND_URL="https://openvolley-backend.onrender.com"

# Projects to create (excluding app which is already done, and bench if you want to skip it)
PROJECTS=("referee" "livescore" "roster" "scoresheet")

echo "Creating Cloudflare Pages projects for OpenVolley..."
echo ""

for project in "${PROJECTS[@]}"; do
    echo "========================================="
    echo "Creating openvolley-$project..."
    echo "========================================="

    # Create project (may fail if already exists, that's ok)
    npx wrangler pages project create "openvolley-$project" --production-branch main 2>/dev/null || echo "Project may already exist, continuing..."

    # Set environment variables
    echo "Setting environment variables..."
    echo "$VITE_SUPABASE_URL" | npx wrangler pages secret put VITE_SUPABASE_URL --project-name "openvolley-$project"
    echo "$VITE_SUPABASE_ANON_KEY" | npx wrangler pages secret put VITE_SUPABASE_ANON_KEY --project-name "openvolley-$project"
    echo "$VITE_BACKEND_URL" | npx wrangler pages secret put VITE_BACKEND_URL --project-name "openvolley-$project"

    echo ""
    echo "Done with openvolley-$project"
    echo ""
done

echo "========================================="
echo "All projects created!"
echo ""
echo "Next steps for each project:"
echo "1. Go to Cloudflare Dashboard > Pages > openvolley-[name]"
echo "2. Settings > Builds & Deployments > Configure:"
echo "   - Build command: npm ci && node scripts/build-subdomains.js [name]"
echo "   - Build output: dist-[name]"
echo "   - Root directory: escoresheet/frontend"
echo "3. Trigger a deploy or push to main"
echo "4. Add custom domain: [name].openvolley.app"
echo "========================================="
