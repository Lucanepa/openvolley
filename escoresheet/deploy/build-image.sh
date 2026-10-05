#!/usr/bin/env bash
# build-image.sh [--ship <ssh-host>] [--allow-dirty] [--allow-prewiring]
#
# Builds openvolley-backend:<git-sha> from escoresheet/backend on the build
# machine (lenovoserver), never on the production host. With --ship it streams
# the image to <ssh-host>, keeps a gzipped copy in /opt/openvolley/images/
# (rollback images survive `docker image prune`, e.g. Coolify's cleanup),
# `docker load`s it there, prunes archives and image tags beyond the newest
# OV_KEEP_IMAGES (default 5; the tag in .env is always kept), and records the
# tag in ${OV_OPS_DIR:-~/ov-ops}/shipped-<ssh-host> (restore-test.sh's default
# image). It does not restart anything: deploying is editing OV_BACKEND_IMAGE
# in /opt/openvolley/.env + `docker compose up -d ov-backend`.
#
# Refuses to build a tree without the self-host wiring (no /health/live,
# DATABASE_URL, STORAGE_ROOT or STATUS_DIR in the backend sources): such an
# image would run today's local relay mode, and must never reach a server.
# --allow-prewiring builds it anyway, tagged <sha>-prewiring, for local kit
# experiments only; it cannot be combined with --ship.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(git -C "$KIT_DIR" rev-parse --show-toplevel)
BACKEND="$REPO/escoresheet/backend"
PLATFORM=${OV_PLATFORM:-linux/amd64}
OV_KEEP_IMAGES=${OV_KEEP_IMAGES:-5}
OV_OPS_DIR=${OV_OPS_DIR:-$HOME/ov-ops}
SHIP=""
ALLOW_DIRTY=0
ALLOW_PREWIRING=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ship) SHIP=${2:?--ship needs an ssh host}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --allow-prewiring) ALLOW_PREWIRING=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$OV_KEEP_IMAGES" =~ ^[1-9][0-9]*$ ]] || { echo "OV_KEEP_IMAGES must be >= 1" >&2; exit 2; }

SHA=$(git -C "$REPO" rev-parse --short=12 HEAD)
if [[ -n "$(git -C "$REPO" status --porcelain -- escoresheet/backend escoresheet/deploy)" ]]; then
  if (( ALLOW_DIRTY )); then
    SHA="${SHA}-dirty"
    [[ -z "$SHIP" ]] || { echo "refusing to ship a dirty build" >&2; exit 1; }
  else
    echo "escoresheet/backend or escoresheet/deploy has uncommitted changes (use --allow-dirty for a local test build)" >&2
    exit 1
  fi
fi

# --- runtime contract (README.md) must be implemented by the backend ----------
missing=()
for token in '/health/live' 'DATABASE_URL' 'STORAGE_ROOT' 'STATUS_DIR'; do
  grep -rqF --include='*.js' --include='*.mjs' --include='*.cjs' \
       --exclude-dir=node_modules --exclude-dir=tests --exclude-dir=test \
       -- "$token" "$BACKEND" || missing+=("$token")
done
if (( ${#missing[@]} )); then
  if (( ALLOW_PREWIRING )) && [[ -z "$SHIP" ]]; then
    echo "[build-image] WARNING: backend lacks ${missing[*]}; building a LOCAL-ONLY pre-wiring image" >&2
    SHA="${SHA}-prewiring"
  else
    echo "[build-image] refusing: escoresheet/backend does not implement the self-host contract (missing: ${missing[*]})." >&2
    echo "  Such an image runs the unauthenticated local relay mode. Merge the self-host wiring first." >&2
    echo "  (--allow-prewiring builds a local-only test image; it can never be shipped.)" >&2
    exit 1
  fi
fi
TAG="openvolley-backend:${SHA}"

echo "[build-image] building ${TAG} (${PLATFORM})"
docker build --platform "$PLATFORM" \
  -f "$KIT_DIR/Dockerfile.backend" \
  --build-arg OV_REVISION="$SHA" \
  -t "$TAG" "$BACKEND"

if [[ -n "$SHIP" ]]; then
  ARCHIVE="/opt/openvolley/images/openvolley-backend-${SHA}.tar.gz"
  echo "[build-image] shipping ${TAG} to ${SHIP}:${ARCHIVE}"
  # shellcheck disable=SC2029  # ARCHIVE is meant to expand locally
  docker save "$TAG" | gzip -1 | ssh "$SHIP" \
    "set -e; umask 077; cat > '${ARCHIVE}.part' && mv '${ARCHIVE}.part' '${ARCHIVE}' && gunzip -c '${ARCHIVE}' | docker load"

  echo "[build-image] pruning ${SHIP}:/opt/openvolley/images to the newest ${OV_KEEP_IMAGES} (plus the deployed tag)"
  ssh "$SHIP" bash -s -- "$OV_KEEP_IMAGES" /opt/openvolley/images /opt/openvolley/.env <"$KIT_DIR/prune-images.sh"

  mkdir -p "$OV_OPS_DIR"
  printf '%s\n' "$TAG" >"$OV_OPS_DIR/shipped-${SHIP}.tmp" && mv -f "$OV_OPS_DIR/shipped-${SHIP}.tmp" "$OV_OPS_DIR/shipped-${SHIP}"
  echo "[build-image] loaded on ${SHIP} (recorded in ${OV_OPS_DIR}/shipped-${SHIP}). Deploy: RUNBOOK-hetzner.md, Updating."
fi
echo "[build-image] ${TAG}"
