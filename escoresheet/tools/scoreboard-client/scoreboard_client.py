#!/usr/bin/env python3
"""Reference client of the scoreboard feed (docs/scoreboard-feed.md).

Prints the score of the match a scoreboard code names, from the cloud or from
a relay in the hall, by polling POST /api/display/live every 2 s. Standard
library only (Python 3.8+).

    python3 scoreboard_client.py --code ABCD-2345
    python3 scoreboard_client.py --code ABCD-2345 --server http://192.168.1.20:5173
    python3 scoreboard_client.py --code ABCD-2345 --once
    OV_SCOREBOARD_CODE=ABCD-2345 python3 scoreboard_client.py

Exit codes: 0, 2 (bad arguments), 3 (the code is not valid or has ended).
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def normalize_code(value):
    """As the relay compares a code: upper case, spaces and dashes removed, 8 symbols."""
    if not isinstance(value, str):
        return None
    s = "".join(ch for ch in value.upper() if ch not in " \t\r\n-")
    return s if len(s) == 8 and all(ch in ALPHABET for ch in s) else None


def num(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def score_line(live, home_team=None, away_team=None):
    """One line for a public live state (Team A / Team B as the scorer names them)."""
    if not isinstance(live, dict):
        return "Waiting for the scorer..."

    def name(v, fallback):
        return v.strip() if isinstance(v, str) and v.strip() else fallback

    def team_name(t):
        return t if isinstance(t, str) else (t or {}).get("name") if isinstance(t, dict) else None

    a = name(live.get("team_a_name"), name(team_name(home_team), "Team A"))
    b = name(live.get("team_b_name"), name(team_name(away_team), "Team B"))
    serving = None
    if live.get("serving_team") and live.get("side_a"):
        serving = "A" if live["serving_team"] == live["side_a"] else "B"
    sets = " ".join("%d:%d" % (num(s.get("a")), num(s.get("b"))) for s in (live.get("set_results") or []) if isinstance(s, dict))
    status = live.get("match_status")
    if status in ("final", "ended"):
        phase = "final"
    elif live.get("timeout_active"):
        phase = "time-out"
    elif live.get("set_interval_active"):
        phase = "set break"
    else:
        phase = "set %d" % (num(live.get("current_set")) or 1)
    parts = [
        "%s%s %d | %d : %d | %d %s%s" % (a, " •" if serving == "A" else "", num(live.get("sets_won_a")), num(live.get("points_a")),
                                        num(live.get("points_b")), num(live.get("sets_won_b")), "• " if serving == "B" else "", b),
        phase,
    ]
    if sets:
        parts.append("sets " + sets)
    parts.append("time-outs %d/%d" % (num(live.get("timeouts_a")), num(live.get("timeouts_b"))))
    if live.get("subs_count_a") is not None or live.get("subs_count_b") is not None:
        parts.append("subs %d/%d" % (num(live.get("subs_count_a")), num(live.get("subs_count_b"))))
    return " · ".join(parts)


def post_live(server, code):
    req = urllib.request.Request(
        server + "/api/display/live",
        data=json.dumps({"code": code}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "scoreboard-client"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read().decode("utf-8")), None
    except urllib.error.HTTPError as err:
        retry = err.headers.get("Retry-After") if err.headers else None
        return err.code, None, int(retry) if retry and retry.isdigit() else None


def main(argv=None):
    p = argparse.ArgumentParser(description="Print the score of a match by its scoreboard code.")
    p.add_argument("--code", default=os.environ.get("OV_SCOREBOARD_CODE", ""))
    p.add_argument("--server", default="https://backend.openvolley.app", help="the relay's HTTP base")
    p.add_argument("--once", action="store_true", help="print one line, then exit")
    p.add_argument("--interval", type=float, default=2.0)
    a = p.parse_args(argv)
    code = normalize_code(a.code)
    if not code:
        p.print_usage(sys.stderr)
        return 2
    server = a.server.rstrip("/")
    last = None
    while True:
        try:
            status, body, retry = post_live(server, code)
        except (urllib.error.URLError, OSError) as err:
            print("No answer (%s), trying again..." % err, file=sys.stderr)
            time.sleep(5)
            continue
        if status == 200 and body and body.get("ok"):
            line = score_line(body.get("liveState"), body.get("homeTeam"), body.get("awayTeam"))
            if line != last:
                print(line, flush=True)
            last = line
            if a.once:
                return 0
            time.sleep(a.interval)
        elif status in (404, 410):
            print("This scoreboard code has ended." if status == 410 else "This scoreboard code is not valid.", file=sys.stderr)
            return 3
        elif status == 429:
            time.sleep(retry or 60)
        else:
            print("No answer (%s), trying again..." % status, file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    sys.exit(main())
