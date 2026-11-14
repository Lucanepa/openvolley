#!/usr/bin/env bash
# Test for release-files.sh with a fake gh: a new release takes every file,
# a published one keeps its files and only gets the missing ones.
#   .github/scripts/test-release-files.sh   (exit 0 = all cases pass)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }

mkdir -p "$T/bin" "$T/a/win" "$T/a/mac"
# FAKE_ASSETS: the published asset names, one per line; unset = no such release
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
[[ "$1 $2" == "release view" ]] || { echo "unexpected gh $*" >&2; exit 3; }
if [[ -n "${FAKE_ERROR:-}" ]]; then echo "$FAKE_ERROR" >&2; exit 1; fi
if [[ -z "${FAKE_ASSETS+x}" ]]; then echo "release not found" >&2; exit 1; fi
printf '%s\n' "$FAKE_ASSETS"
GH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
printf 'win' > "$T/a/win/App_1.0.0_x64-setup.exe"
printf 'dmg' > "$T/a/mac/App_1.0.0_universal.dmg"
run() { GITHUB_OUTPUT="$T/out.txt" "$HERE/release-files.sh" v1 "$T/up$1" "$T/sums$1.md" "$T"/a/*/* "$T/a/none.deb" > "$T/log$1" 2>&1; }

# a new release: every file, with its SHA-256
: > "$T/out.txt"
if (unset FAKE_ASSETS; run 1); then
  [[ -f "$T/up1/App_1.0.0_x64-setup.exe" && -f "$T/up1/App_1.0.0_universal.dmg" ]] && ok "new release: both files" || bad "new release: files"
  grep -qx 'exists=false' "$T/out.txt" && grep -qx 'count=2' "$T/out.txt" && ok "new release: outputs" || bad "new release: outputs $(cat "$T/out.txt")"
  grep -q "^$(printf win | sha256sum | cut -d' ' -f1)  App_1.0.0_x64-setup.exe\$" "$T/sums1.md" && grep -q '^### SHA-256' "$T/sums1.md" &&
    ok "new release: SHA-256 in the notes" || bad "new release: sums $(cat "$T/sums1.md")"
else bad "new release failed: $(cat "$T/log1")"; fi

# published with the Windows installer only: the .exe stays, the .dmg is added
: > "$T/out.txt"
if FAKE_ASSETS='App_1.0.0_x64-setup.exe' run 2; then
  [[ ! -e "$T/up2/App_1.0.0_x64-setup.exe" && -f "$T/up2/App_1.0.0_universal.dmg" ]] && ok "published: only the missing file" || bad "published: $(ls "$T/up2")"
  grep -qx 'exists=true' "$T/out.txt" && grep -qx 'count=1' "$T/out.txt" && ok "published: outputs" || bad "published: outputs $(cat "$T/out.txt")"
  grep -q 'kept the published App_1.0.0_x64-setup.exe' "$T/log2" && ok "published: says what it kept" || bad "published: log"
else bad "published failed: $(cat "$T/log2")"; fi

# published with everything: nothing to upload, no failure
: > "$T/out.txt"
if FAKE_ASSETS=$'App_1.0.0_x64-setup.exe\nApp_1.0.0_universal.dmg' run 3; then
  grep -qx 'count=0' "$T/out.txt" && [[ -z "$(ls -A "$T/up3")" ]] && ok "complete release: nothing replaced" || bad "complete release: $(ls "$T/up3")"
else bad "complete release failed: $(cat "$T/log3")"; fi

# GitHub cannot be asked: fail, never take it for a new release
if FAKE_ERROR='HTTP 502' run 4; then bad "an API error passed"; else ok "an API error fails"; fi

# a new release without any file fails
if (unset FAKE_ASSETS; GITHUB_OUTPUT=/dev/null "$HERE/release-files.sh" v1 "$T/up5" "$T/sums5.md" "$T/a/none.exe" >/dev/null 2>&1); then
  bad "an empty new release passed"; else ok "an empty new release fails"; fi

if (( fails )); then echo "$fails case(s) failed"; exit 1; fi
echo "all cases passed"
