#!/usr/bin/env python3
"""
render_basketball_samples.py — render the BASKETBALL screens through openscore with NO panel
and NO bridge, so the basketball scoreboard can be eyeballed headless (a sibling of
render_beach_samples.py).

It points the Device at the namespaced basketball layout dir
(firmware/openscore/layouts-basketball/) while keeping the shared base_dir (for
media/kscw_crest.png), then feeds each screen the exact one-attrib-per-entry SetSections WRITE
shape the bridge sends, and copies each composed www/buffer.png into
layouts-basketball/samples/<name>.png.

The last screen (06_basketball_from_jsmapper) is rendered from the ACTUAL toBasketballSections()
output — the real src/basketballMapper.proposal.js is invoked via node, and its section list is
pushed through the real firmware Device (SetLayout + SetSections), exactly the mapper->board path
the appliance uses, headless. That step is best-effort: if node is unavailable it is skipped with
a note (the five hand-built screens still render).

Run:  python3 render_basketball_samples.py   (needs Pillow; node for screen 06)
"""
import json
import os
import shutil
import subprocess

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))
BASKET_DIR = os.path.join(HERE, "layouts-basketball")
OUT = os.path.join(BASKET_DIR, "samples")
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))

# KSCW blue vs a warm orange opponent, matching the layouts' default team colours.
BLUE = "37,99,235"
ORANGE = "255,69,0"
WHITE = "255,255,255"
NEUTRAL = "200,200,200"
AMBER = "255,176,0"     # a team-foul count one short of the bonus
MAXED = "170,0,20"      # in the bonus/penalty, or all timeouts used
BONUS_LIT = "255,60,40"  # per-side penalty marker, lit
BONUS_DIM = "40,40,40"   # per-side penalty marker, idle
OFF = "30,30,30"
BONUS_AT = 5             # FIBA: penalty from the 5th team foul in a period
TO_TOTAL = 5             # club default game timeouts (see the design doc)


def attr(name, a, v):
    """The LedBox SetSections WRITE shape: one {attrib,value} per entry (per PROTOCOL.md)."""
    return {"name": name, "value": {"attrib": a, "value": str(v)}}


def text(name, v, color=None):
    out = [attr(name, "text", v)]
    if color:
        out.append(attr(name, "color", color))
    return out


def box(name, color):
    # black fill so a big number reads; border in the team colour (bordercolor is real).
    return [attr(name, "color", "0,0,0"), attr(name, "bordercolor", color)]


def rect(name, color):
    return [attr(name, "color", color)]


def foul_color(n):
    if n >= BONUS_AT:
        return MAXED
    if n >= BONUS_AT - 1:
        return AMBER
    return NEUTRAL


def scoreboard(score1, score2, period, f1, f2, to1, to2, poss):
    """One basketball match screen. `period` is a label (Q1..Q4 / OT1 / FINAL); `f1`/`f2` are
    team fouls (the bonus marker lights at 5); `poss` is the possession side ('left'/'right')."""
    return (
        text("team1", "KSCW", BLUE) + text("team2", "GAST", ORANGE)
        + text("score1", score1, BLUE) + text("score2", score2, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + text("period", period, WHITE)
        + text("foul1", f1, foul_color(f1)) + text("foul2", f2, foul_color(f2))
        + text("bonus1", "•" if f1 >= BONUS_AT else "", BONUS_LIT if f1 >= BONUS_AT else BONUS_DIM)
        + text("bonus2", "•" if f2 >= BONUS_AT else "", BONUS_LIT if f2 >= BONUS_AT else BONUS_DIM)
        + text("timeout1", to1, MAXED if to1 >= TO_TOTAL else NEUTRAL)
        + text("timeout2", to2, MAXED if to2 >= TO_TOTAL else NEUTRAL)
        + rect("serve1", BLUE if poss == "left" else OFF)
        + rect("serve2", ORANGE if poss == "right" else OFF)
    )


SCREENS = [
    # First quarter mid-game: 12-8, left has the possession arrow, no team in the bonus yet.
    ("01_basketball_scoreboard", "basketball_matchscore",
        scoreboard(12, 8, "Q1", 2, 1, 0, 1, "left")),
    # Third quarter, home in the bonus (5 team fouls) — the penalty marker is lit, foul count red.
    ("02_basketball_bonus", "basketball_matchscore",
        scoreboard(58, 61, "Q3", 5, 3, 2, 1, "right")),
    # First overtime: tied game went to OT1; team fouls have carried over from Q4.
    ("03_basketball_overtime", "basketball_matchscore",
        scoreboard(90, 92, "OT1", 3, 4, 5, 4, "left")),
    # Pre-match idle: crest + the two team names. The fontsize entries mimic what the mapper does
    # at runtime (fit each name to the ~119px name column) so a long team name never clips.
    ("04_basketball_idle", "basketball_idle",
        text("team1", "KSCW BASKET", "255,200,50") + [attr("team1", "fontsize", 18)]
        + text("team2", "GAST", ORANGE) + [attr("team2", "fontsize", 22)]),
    # Crest-only heartbeat.
    ("05_basketball_crest", "basketball_crest", []),
]


def js_mapper_sections(node_bin):
    """Invoke the REAL src/basketballMapper.proposal.js through node and return its section list
    for a Q3 penalty state, so screen 06 exercises the actual mapper->board path."""
    mapper_url = "file://" + os.path.join(REPO, "src", "basketballMapper.proposal.js")
    state = {
        "side_a": "left",
        "team_a_short": "LAL", "team_a_color": "#552583",
        "team_b_short": "BOS", "team_b_color": "#007a33",
        "points_a": 71, "points_b": 68, "sets_won_a": 0, "sets_won_b": 0,
        "timeouts_a": 2, "timeouts_b": 1, "subs_a": 5, "subs_b": 3,
        "serving_team": "left", "period": 3, "over": False,
    }
    js = (
        "import { toBasketballSections } from '%s';\n" % mapper_url
        + "const state = %s;\n" % json.dumps(state)
        + "process.stdout.write(JSON.stringify(toBasketballSections(state)));\n"
    )
    raw = subprocess.check_output([node_bin, "--input-type=module", "-e", js], cwd=REPO)
    return json.loads(raw)


def find_node():
    for c in [os.environ.get("NODE"), shutil.which("node"),
              os.path.expanduser("~/.nvm/versions/node/v24.15.0/bin/node"),
              "/opt/nodejs/bin/node"]:
        if c and os.path.exists(c):
            return c
    return None


def main():
    if not olb._HAVE_PIL:
        raise SystemExit("Pillow not installed: pip install pillow")
    os.makedirs(OUT, exist_ok=True)
    cfg = olb.build_config(HERE)
    cfg["layout_dir"] = BASKET_DIR       # load the namespaced basketball layouts...
    cfg["idle_layout"] = "basketball_crest"  # ...and idle on the crest instead of `waiting`
    # base_dir stays HERE so `media/kscw_crest.png` still resolves (shared artwork).
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)

    def snapshot(name):
        shutil.copy(cfg["buffer_path"], os.path.join(OUT, name + ".png"))
        print("  wrote layouts-basketball/samples/%s.png" % name)

    screens = list(SCREENS)

    # Screen 06 — the real JS mapper pushed through the real firmware (best-effort).
    node_bin = find_node()
    if node_bin:
        try:
            screens.append(("06_basketball_from_jsmapper", "basketball_matchscore",
                            js_mapper_sections(node_bin)))
        except Exception as e:  # noqa: BLE001 - a node hiccup must not sink the hand-built screens
            print("  (skipping 06_basketball_from_jsmapper: %s)" % e)
    else:
        print("  (skipping 06_basketball_from_jsmapper: node not found)")

    for name, layout, sections in screens:
        reply = device.handle({"cmd": "SetLayout", "value": layout})
        assert reply["status"] == "ok", (name, reply)
        if sections:
            reply = device.handle({"cmd": "SetSections", "value": sections})
            assert reply["status"] == "ok", (name, reply)
        snapshot(name)

    print("OK — %d basketball sample screens in %s" % (len(screens), OUT))


if __name__ == "__main__":
    main()
