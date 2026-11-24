#!/usr/bin/env bash
# build-render-image.sh [--ship <ssh-host>] [--allow-dirty]
#
# Builds openvolley-render:<git-sha> (the vector scoresheet PDF service,
# Dockerfile.render, field-spec 17.20) from the COMMITTED escoresheet/frontend
# and escoresheet/render trees (git archive HEAD), like build-image.sh does
# for the backend. --ship <ssh-host> streams it to the host, keeps a gzipped
# copy in /opt/openvolley/images/ and `docker load`s it there; deploying is
# setting OV_RENDER_IMAGE in /opt/openvolley/.env and `docker compose up -d`
# (README.md, "Vector PDF"). --allow-dirty builds the working tree, tagged
# <sha>-dirty, for local tests only (never shipped).
set -euo pipefail
KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
REPO=$(git -C "$KIT_DIR" rev-parse --show-toplevel)
PLATFORM=${OV_PLATFORM:-linux/amd64}
SHIP=""
ALLOW_DIRTY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ship) SHIP=${2:?--ship needs an ssh host}; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
SHA=$(git -C "$REPO" rev-parse --short=12 HEAD)
CONTEXT=$(mktemp -d "${TMPDIR:-/tmp}/ov-render-context.XXXXXX")
trap 'rm -rf "$CONTEXT"' EXIT
mkdir -p "$CONTEXT/frontend" "$CONTEXT/render"
if [[ -n "$(git -C "$REPO" status --porcelain -- escoresheet/frontend escoresheet/render escoresheet/deploy/Dockerfile.render)" ]]; then
  (( ALLOW_DIRTY )) || { echo "escoresheet/frontend, escoresheet/render or Dockerfile.render has uncommitted changes (--allow-dirty for a local test build)" >&2; exit 1; }
  [[ -z "$SHIP" ]] || { echo "refusing to ship a dirty build" >&2; exit 1; }
  SHA="${SHA}-dirty"
  # the working tree without what git ignores (node_modules, dist*)
  (cd "$REPO/escoresheet/frontend" && git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -x -C "$CONTEXT/frontend")
  (cd "$REPO/escoresheet/render" && git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -x -C "$CONTEXT/render")
else
  git -C "$REPO" archive --format=tar HEAD:escoresheet/frontend | tar -x -C "$CONTEXT/frontend"
  git -C "$REPO" archive --format=tar HEAD:escoresheet/render | tar -x -C "$CONTEXT/render"
fi
TAG="openvolley-render:${SHA}"
echo "[build-render-image] building ${TAG} (${PLATFORM})"
docker build --platform "$PLATFORM" -f "$KIT_DIR/Dockerfile.render" --build-arg OV_REVISION="$SHA" -t "$TAG" "$CONTEXT"
docker image ls "$TAG" --format '[build-render-image] {{.Repository}}:{{.Tag}} {{.Size}}'
if [[ -n "$SHIP" ]]; then
  ARCHIVE="/opt/openvolley/images/openvolley-render-${SHA}.tar.gz"
  echo "[build-render-image] shipping ${TAG} to ${SHIP}:${ARCHIVE}"
  ROOT='$( [ "$(id -u)" = 0 ] || echo sudo -n )'
  # shellcheck disable=SC2029
  docker save "$TAG" | gzip -1 | ssh "$SHIP" \
    "set -e; R=${ROOT}; \$R sh -c \"umask 077; cat > '${ARCHIVE}.part' && mv '${ARCHIVE}.part' '${ARCHIVE}' && gunzip -c '${ARCHIVE}' | docker load\""
  echo "[build-render-image] loaded on ${SHIP}. Deploy: OV_RENDER_IMAGE=${TAG} in /opt/openvolley/.env, then docker compose up -d (README.md, Vector PDF)."
fi
echo "[build-render-image] ${TAG}"
