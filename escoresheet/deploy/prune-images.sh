#!/usr/bin/env bash
# prune-images.sh KEEP IMAGES_DIR ENV_FILE
#
# Runs on the server (build-image.sh --ship pipes it over ssh; can also be run
# by hand). Keeps the newest KEEP openvolley-backend-<sha>.tar.gz archives in
# IMAGES_DIR plus the archive of the tag currently set in ENV_FILE
# (OV_BACKEND_IMAGE), deletes the rest, and removes the matching
# openvolley-backend:<sha> image tags. `docker rmi` without -f refuses an image
# that any container (running or stopped) still uses, so a live image is never
# removed.
set -euo pipefail

KEEP=${1:?keep count}
DIR=${2:?images dir}
ENV_FILE=${3:?env file}
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "[prune-images] bad keep count: $KEEP" >&2; exit 2; }
[[ -d "$DIR" ]] || { echo "[prune-images] no ${DIR}, nothing to prune"; exit 0; }

cur=""
if [[ -r "$ENV_FILE" ]]; then
  cur=$(sed -n 's/^OV_BACKEND_IMAGE=//p' "$ENV_FILE" | tail -n1 | tr -d "\"'\r")
  cur=${cur#openvolley-backend:}
fi

n=0
while IFS= read -r f; do
  n=$((n + 1))
  sha=${f#openvolley-backend-}; sha=${sha%.tar.gz}
  (( n > KEEP )) || continue
  if [[ -n "$cur" && "$sha" == "$cur" ]]; then
    echo "[prune-images] keeping ${f} (deployed)"
    continue
  fi
  rm -f -- "${DIR:?}/${f}"
  if docker rmi "openvolley-backend:${sha}" >/dev/null 2>&1; then
    echo "[prune-images] removed ${f} and image openvolley-backend:${sha}"
  else
    echo "[prune-images] removed ${f} (image tag absent or still used by a container)"
  fi
done < <(cd "$DIR" && find . -maxdepth 1 -type f -name 'openvolley-backend-*.tar.gz' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)
