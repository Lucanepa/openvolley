#!/usr/bin/env python3
"""
render_samples.py — drive the openscore Device through every screen the bridge uses and
save a PNG of each, so the renderer can be eyeballed with NO panel and NO bridge.

It feeds the Device the same {cmd,value} messages the bridge sends over the wire (SetLayout +
the one-attrib-per-entry SetSections WRITE shape), then copies each composed www/buffer.png to
samples/<name>.png. Run:  python3 render_samples.py   (needs Pillow)
"""
import os
import shutil

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")

# KSCW blue vs a warm orange opponent, matching the layouts' default team colours.
BLUE = "37,99,235"
ORANGE = "255,69,0"


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


def scoreboard():
    return (
        # Short codes on the match screen, exactly as the bridge paints it (full names are
        # reserved for the width-fitted crest idle screen).
        text("team1", "WIEDIKON", BLUE) + text("team2", "VOLZ", ORANGE)
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + text("set1", 1, BLUE) + text("set2", 1, ORANGE)
        + [attr("vs", "text", "-")]
        + text("timeout1", 1, "200,200,200") + text("timeout2", 2, "170,0,20")
        + text("sub1", 3, "200,200,200") + text("sub2", 6, "170,0,20")
        + rect("serve1", BLUE) + rect("serve2", "30,30,30")
    )


def break_screen():
    return (
        [attr("lbl", "text", "TIME OUT"), attr("team", "text", "WIEDIKON"),
         attr("timer", "text", "0:22"), attr("timerbig", "text", "")]
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + text("set1", 1, BLUE) + text("set2", 1, ORANGE)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
    )


def vendor_countdown():
    return (
        [attr("timer", "text", "30"), attr("lbl", "text", "TIMEOUT"), attr("sep", "text", "-")]
        + text("score1", 18, BLUE) + text("score2", 16, ORANGE)
        + text("set1", 1) + text("set2", 1)
        + box("bg_score1", BLUE) + box("bg_score2", ORANGE)
        + [attr("media", "src", "")]  # blank the vendor logo so the clock owns the screen
    )


def tennis():
    return (
        text("team1", "FEDERER", "255,165,0") + text("team2", "NADAL", "50,205,50")
        + text("score1", 40, "255,165,0") + text("score2", 30, "50,205,50")
        + text("set1game1", 6) + text("set2game1", 3)
        + rect("serve1", "255,165,0") + rect("serve2", "0,0,0")  # serve = filled circle
    )


SCREENS = [
    ("00_waiting", None, None),                              # boot idle (no client)
    ("01_scoreboard", "volleyball_matchscore_02", scoreboard()),
    ("02_kscw_idle", "kscw_idle",
        text("team1", "KSC WIEDIKON", "255,200,50") + text("team2", "VBC ZUG", ORANGE)),
    ("03_kscw_crest", "kscw_crest", []),
    ("04_break", "kscw_break", break_screen()),
    ("05_vendor_countdown", "volleyball_matchscore_timeout_02", vendor_countdown()),
    ("06_tennis_circle", "tennis_matchscore", tennis()),
]


def main():
    if not olb._HAVE_PIL:
        raise SystemExit("Pillow not installed: pip install pillow")
    os.makedirs(OUT, exist_ok=True)
    cfg = olb.build_config(HERE)
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)  # boots showing the idle/waiting screen

    def snapshot(name):
        shutil.copy(cfg["buffer_path"], os.path.join(OUT, name + ".png"))
        print("  wrote samples/%s.png" % name)

    for name, layout, sections in SCREENS:
        if layout:
            reply = device.handle({"cmd": "SetLayout", "value": layout})
            assert reply["status"] == "ok", (name, reply)
        if sections:
            reply = device.handle({"cmd": "SetSections", "value": sections})
            assert reply["status"] == "ok", (name, reply)
        snapshot(name)

    # The procedural network-info screen (showInfo).
    device.show_info()
    snapshot("07_info")
    print("OK — %d sample screens in %s" % (len(SCREENS) + 1, OUT))


if __name__ == "__main__":
    main()
