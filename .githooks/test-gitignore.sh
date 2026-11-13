#!/usr/bin/env bash
# Regression test for the match-data rules in .gitignore: files the apps and
# tools write (backups, logs, diagnostics, exports, roster/licence lists,
# scoresheet PDFs) must be ignored wherever they land in the checkout, while
# test fixtures and the docs' guides stay trackable. Lives next to
# test-gitleaks-config.sh: .gitignore keeps these files out of `git add`, the
# gitleaks rules catch what is added anyway.
#
# Usage: .githooks/test-gitignore.sh   (exit 0 = all cases pass)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fails=0

# expect <ignored|kept> <path>   (the path need not exist)
expect() {
  local want="$1" path="$2" got=kept
  if git check-ignore --no-index -q -- "$path"; then got=ignored; fi
  if [[ "$got" == "$want" ]]; then
    echo "ok   $want $path"
  else
    echo "FAIL want $want, got $got: $path"; fails=$((fails + 1))
  fi
}

# App backups (backupManager, logger, Scoreboard downloads), in any folder.
expect ignored backup_g1_set2_scoreleft15_scoreright12_20250104_153045_123.json
expect ignored escoresheet/frontend/backup_g3_set2_scoreleft12_scoreright10_20261112_101500_123.json
expect ignored exports/game3/backup_g3_set1_scoreleft25_scoreright20_20261112_1015.json
expect ignored escoresheet/frontend/backup_set2_match_1_2026-11-12T10-15-00-000Z.json
# Native auto-backups (one folder per match) and USB stick copies.
expect ignored game3-match_1/20261112T101500.123Z-00042.json
expect ignored OpenVolley/backups/game3-match_1759740000000_ab12cd/latest.json
expect ignored some/dir/game3-local5/latest.json
expect ignored game9/latest.json
expect ignored match-xyz/latest.json
expect ignored exports/match-5/latest.json
expect ignored test-game1-s/latest.json
expect ignored test-match-xyz/latest.json
expect ignored OpenVolley/game3-match_1/a1b2c3d4-latest.json
expect ignored OpenVolley/game3-match_1/a1b2c3d4-manual-20261112T101500Z.json
# Logs, diagnostics and activity exports; browser network exports.
expect ignored tools/debug_logs/notes.md
expect ignored escoresheet/frontend/logs_match_3_2026-11-12T10-15-00-000Z.txt
expect ignored logs/game3/logs_20261112T101500Z_1a.txt
expect ignored diagnostic_log_game3_2026-11-12T10-15-00-000Z.ndjson
expect ignored diagnostic_log_2026-11-12T10-15-00-000Z.json
expect ignored openvolley-diagnostics-20261112-1015-g3.txt
expect ignored openvolley-diagnostics-2026-11-12T10-15-00-000Z.jsonl
expect ignored downloads/openvolley-diagnostics.txt
expect ignored openvolley-activity-match3-2026-11-12T10-15-00-000Z.csv
expect ignored openvolley-activity-all-2026-11-12T10-15-00-000Z.json
expect ignored openvolley-activity-2026-11-12T10-15-00-000Z.ndjson
expect ignored downloads/openvolley-activity.json
expect ignored logs/activity-2026-11-12.jsonl
expect ignored logs/diagnostics-2026-11-12.jsonl
expect ignored downloads/localhost.har
# Match exports.
expect ignored MatchData_Home_vs_Away_2026-11-12.json
expect ignored Match_Home_vs_Away_2026-11-12.zip
expect ignored match-data-3.json
expect ignored match_stopped_3_2026-11-12.json
expect ignored exports/database_export_3_2026-11-12.json
# Roster, licence and ranking lists; scoresheets and participant lists as PDF.
expect ignored escoresheet/frontend/club-licences.xlsx
expect ignored exports/team-list.xls
expect ignored exports/team-list.ods
expect ignored escoresheet/frontend/ranking-open-2026.csv
expect ignored escoresheet/frontend/roster.tsv
expect ignored downloads/participants-game3.pdf
expect ignored downloads/scoresheet_game3.pdf
# A folder merely named like "fixtures" (a league's match schedule) is no test tree.
expect ignored league-fixtures/2026/ranking.csv
expect ignored league-fixtures/2026/backup_g3_set1_scoreleft0_scoreright0_20261112_101500_123.json
expect ignored escoresheet/frontend/fixtures/participants.pdf

# Fixtures, docs and code stay trackable.
expect kept escoresheet/frontend/src-tauri/tests/fixtures/latest.json
expect kept escoresheet/frontend/src/utils/__tests__/fixtures/fdroid-index-v2.json
expect kept escoresheet/frontend/electron/__fixtures__/sign-vectors.json
expect kept escoresheet/backend/tests/fixtures/beach-de/de-8.txt
expect kept escoresheet/backend/tests/fixtures/backup_g1_set1_scoreleft0_scoreright0_20250104_153045_123.json
expect kept escoresheet/backend/tests/fixtures/game1-match_1/latest.json
expect kept escoresheet/backend/tests/fixtures/roster.pdf
expect kept escoresheet/backend/tests/fixtures/session.har
expect kept escoresheet/frontend/src/domain/__tests__/fixtures/licences.xlsx
expect kept escoresheet/frontend/src/domain/__tests__/fixtures/ranking.csv
expect kept escoresheet/docs/guides/team-links/OpenVolley-Teamlinks-Vereine.pdf
expect kept escoresheet/docs/guides/new-guide.pdf
expect kept escoresheet/frontend/src/utils/backupManager.js
expect kept escoresheet/frontend/src/utils/logger.js
expect kept escoresheet/frontend/src-tauri/capabilities/backup.json
expect kept escoresheet/frontend/src/i18n/locales/en.json
expect kept escoresheet/deploy/backup-openvolley.sh
expect kept escoresheet/docs/diagnostics-mode.md
expect kept escoresheet/deploy/latest.json
expect kept escoresheet/deploy/systemd/openvolley-backup-files.service
expect kept escoresheet/deploy/systemd/openvolley-diagnostics-cleanup.timer
expect kept escoresheet/docs/openvolley-activity-log.md

# No tracked file may be ignored: a rule that swallows one would hide the next
# fixture or doc of its kind from `git add`.
tracked_ignored="$(git ls-files -i -c --exclude-standard)"
if [[ -n "$tracked_ignored" ]]; then
  echo "FAIL tracked files that .gitignore ignores:"; sed 's/^/       /' <<<"$tracked_ignored"
  fails=$((fails + 1))
else
  echo "ok   no tracked file is ignored"
fi

if (( fails > 0 )); then
  echo "$fails case(s) failed"; exit 1
fi
echo "all cases passed"
