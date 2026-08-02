#!/usr/bin/env python3
"""
render_beach_samples.py — render the BEACH volleyball screens through openscore with NO panel
and NO bridge, so the beach scoreboard can be eyeballed headless (a sibling of render_samples.py).

It points the Device at the namespaced beach layout dir (firmware/openscore/layouts-beach/) while
keeping the shared base_dir (for media/kscw_crest.png), then feeds each screen the exact one-attrib-
per-entry SetSections WRITE shape the bridge sends, and copies each composed www/buffer.png into
layouts-beach/samples/<name>.png.  Run:  python3 render_beach_samples.py   (needs Pillow)
"""
import os
import shutil

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))
BEACH_DIR = os.path.join(HERE, "layouts-beach")
OUT = os.path.join(BEACH_DIR, "samples")

# KSCW blue vs a warm orange opponent, matching the layouts' default team colours.
BLUE = "37,99,235"
ORANGE = "255,69,0"
AMBER = "255,176,0"     # court-switch cue colour (mirrors the mapper's WARN colour)
DIM = "60,60,60"
OFF = "30,30,30"
MAXED = "170,0,20"      # a used-up beach timeout (1 per set) goes dark red


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


def scoreboard(score1, score2, set1, set2, to1, to2, serve, switch_due):
    """One beach match screen. `switch_due` lights the centre SWITCH cue amber."""
    out = (
        text("team1", "MOL/SOR", BLUE) + text("team2", "ART/DAL", ORANGE)
        + text("score1", score1, BLUE) + text("score2", score2, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + text("set1", set1, BLUE) + text("set2", set2, ORANGE)
        + [attr("vs", "text", "-")]
        + text("timeout1", to1, MAXED if to1 else "200,200,200")
        + text("timeout2", to2, MAXED if to2 else "200,200,200")
        + rect("serve1", BLUE if serve == "left" else OFF)
        + rect("serve2", ORANGE if serve == "right" else OFF)
    )
    out += text("switch", "SWITCH" if switch_due else "", AMBER if switch_due else DIM)
    return out


SCREENS = [
    # A set 1 rally sitting exactly on a court switch (sum = 7): the SWITCH cue is lit.
    ("01_beach_scoreboard", "beach_matchscore",
        scoreboard(4, 3, 0, 0, 0, 1, "left", switch_due=True)),
    # Mid set-2, no switch pending, right pair serving, both timeouts still available.
    ("02_beach_midset", "beach_matchscore",
        scoreboard(15, 12, 1, 0, 0, 0, "right", switch_due=False)),
    # Deciding set (1-1), target 15, switch cadence 5 — sum = 20 lands on a switch.
    ("03_beach_deciding", "beach_matchscore",
        scoreboard(12, 8, 1, 1, 1, 0, "left", switch_due=True)),
    # Pre-match idle: crest + the two pair names. The fontsize entries mimic what the mapper
    # does at runtime (fit each name to the ~119px name column) so a long pair name never clips.
    ("04_beach_idle", "beach_idle",
        text("team1", "MOL/SORUM", "255,200,50") + [attr("team1", "fontsize", 20)]
        + text("team2", "ARTACHO/DAL", ORANGE) + [attr("team2", "fontsize", 18)]),
    # Crest-only heartbeat.
    ("05_beach_crest", "beach_crest", []),
]


def main():
    if not olb._HAVE_PIL:
        raise SystemExit("Pillow not installed: pip install pillow")
    os.makedirs(OUT, exist_ok=True)
    cfg = olb.build_config(HERE)
    cfg["layout_dir"] = BEACH_DIR       # load the namespaced beach layouts...
    cfg["idle_layout"] = "beach_crest"  # ...and idle on the crest instead of `waiting`
    # base_dir stays HERE so `media/kscw_crest.png` still resolves (shared artwork).
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)

    def snapshot(name):
        shutil.copy(cfg["buffer_path"], os.path.join(OUT, name + ".png"))
        print("  wrote layouts-beach/samples/%s.png" % name)

    for name, layout, sections in SCREENS:
        reply = device.handle({"cmd": "SetLayout", "value": layout})
        assert reply["status"] == "ok", (name, reply)
        if sections:
            reply = device.handle({"cmd": "SetSections", "value": sections})
            assert reply["status"] == "ok", (name, reply)
        snapshot(name)

    print("OK — %d beach sample screens in %s" % (len(SCREENS), OUT))


if __name__ == "__main__":
    main()
