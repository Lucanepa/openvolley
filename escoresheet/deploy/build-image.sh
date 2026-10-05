#!/usr/bin/env bash
# build-image.sh [--ship <ssh-host>] [--allow-dirty]
#
# Builds openvolley-backend:<git-sha> from escoresheet/backend on the build
# machine (lenovoserver), never on the production host. With --ship it streams
# the image to <ssh-host>, keeps a gzipped copy in /opt/openvolley/images/
# (rollback images survive `docker image prune`, e.g. Coolify's cleanup) and
# `docker load`s it there. It does not restart anything: deploying is
# editing OV_BACKEND_IMAGE in /opt/openvolley/.env + `docker compose up -d`.
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(git -C "$KIT_DIR" rev-parse --show-toplevel)
BACKEND="$REPO/escoresheet/backend"
PLATFORM=${OV_PLATFORM:-linux/amd64}
SHIP=""
ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ship) SHIP=${2:?--ship needs an ssh host}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

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
  echo "[build-image] loaded on ${SHIP}. Deploy with:"
  echo "  ssh ${SHIP} \"sed -i 's|^OV_BACKEND_IMAGE=.*|OV_BACKEND_IMAGE=${TAG}|' /opt/openvolley/.env && cd /opt/openvolley && docker compose up -d ov-backend\""
fi
echo "[build-image] ${TAG}"
