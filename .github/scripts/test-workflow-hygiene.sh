#!/usr/bin/env bash
# Regression test for workflow-hygiene.sh: this repo's workflows pass; a clean
# two-job signing workflow passes; each thing ios.yml had before its split
# (SEC-23) fails on its own with its message.
#
# Usage: .github/scripts/test-workflow-hygiene.sh   (exit 0 = all cases pass)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/workflow-hygiene.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0
pass() { echo "ok   $*"; }
fail() { echo "FAIL $*"; fails=$((fails + 1)); }

out=$("$CHECK" 2>&1) && pass "this repo's workflows are clean" || { fail "this repo's workflows"; sed 's/^/       /' <<<"$out"; }

SHA=3d3c42e5aac5ba805825da76410c181273ba90b1
clean() {
  cat <<EOF
name: t
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@$SHA # v7.0.1
        with:
          persist-credentials: false
      - run: npm ci
  sign:
    needs: build
    runs-on: macos-15
    environment: signing
    steps:
      - uses: actions/checkout@$SHA # v7.0.1
        with:
          sparse-checkout: a.plist
          persist-credentials: false
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
      - name: Sign
        env:
          KEY: \${{ secrets.SIGNING_KEY }}
        run: security import k.p12 -k kc -x -T /usr/bin/codesign
EOF
}

# expect <ok|fails> <label> <message part> <sed expression applied to the clean workflow>
expect() {
  local want=$1 label=$2 msg=$3 expr=$4 d rc=0
  d="$TMP/$((RANDOM))"; mkdir -p "$d"
  clean | sed -e "$expr" > "$d/w.yml"
  out=$("$CHECK" "$d" 2>&1) || rc=$?
  if [[ "$want" == ok && "$rc" == 0 ]]; then pass "$label"
  elif [[ "$want" == fails && "$rc" == 1 ]] && grep -qF -- "$msg" <<<"$out"; then pass "$label"
  else fail "$label (want $want '$msg', exit $rc)"; sed 's/^/       /' <<<"$out"; fi
}

expect ok    "clean build + signing jobs"           ""                                   's/^$//'
expect fails "action on a tag"                      "not pinned to a commit SHA"         "0,/actions\/checkout@$SHA/s//actions\/checkout@v7/"
expect fails "no permissions block"                 "no top-level permissions block"     '/^permissions:/,+1d'
expect fails "token kept in .git/config"            "without persist-credentials: false" '0,/persist-credentials: false/s//fetch-depth: 1/'
expect fails "signing job without environment"      "not in a GitHub environment"        '/environment: signing/d'
expect fails "npm next to the signing key"          "runs a package tool"                's/run: security import/run: npm ci \&\& security import/'
expect fails "third-party action next to the key"   "uses softprops/action-gh-release"   's#actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333#softprops/action-gh-release@8a0cd651e5b2365bd640854a3fa5dfc70e4875f3#'
expect fails "key usable by /usr/bin/security"      "lets /usr/bin/security use"         's#-T /usr/bin/codesign#-T /usr/bin/codesign -T /usr/bin/security#'
expect fails "pull_request_target trigger"          "pull_request_target"                's/^  workflow_dispatch:/  pull_request_target:/'

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
