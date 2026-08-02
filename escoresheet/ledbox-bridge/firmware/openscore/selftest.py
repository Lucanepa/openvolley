#!/usr/bin/env python3
"""
selftest.py — prove openscore over a REAL TCP socket, with no bridge and no panel.

Spins up the server in a thread, connects a raw socket, and speaks the exact gzip/JSON wire
format the bridge uses (verified against src/ledboxProtocol.js): Init(version=2) handshake,
SetLayout, the one-attrib-per-entry SetSections WRITE shape, SetSection, GetLayout, showInfo,
Horn, and the four error paths (bad layout=5, unknown section=6, malformed shape=9, unknown
cmd=1). Asserts every reply and that a 192x64 buffer.png gets rendered. Prints PASS/FAIL.

    python3 selftest.py            # self-hosted server on 127.0.0.1:18889
    python3 selftest.py --port N   # pick the port
"""
import argparse
import os
import socket
import threading
import time

import openscore as olb

HERE = os.path.dirname(os.path.abspath(__file__))


class Client:
    """Minimal request/response client: gzip-frame a {cmd,value}, read one reply frame."""

    def __init__(self, host, port):
        self.sock = socket.create_connection((host, port), timeout=5)
        self.dec = olb.StreamDecoder()

    def call(self, cmd, value=None, **extra):
        frame = {"cmd": cmd, **extra}
        if value is not None:
            frame["value"] = value
        self.sock.sendall(olb.encode(frame))
        # Read until the decoder yields the matching reply.
        while True:
            msgs = self.dec.push(self.sock.recv(65536))
            for m in msgs:
                if m.get("sender") == cmd:
                    return m
            if not msgs:
                time.sleep(0.01)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def attr(name, a, v):
    return {"name": name, "value": {"attrib": a, "value": str(v)}}


def start_server(port):
    cfg = olb.build_config(HERE)
    cfg["port"] = port
    renderer = olb.Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"])
    device = olb.Device(cfg, renderer)
    srv = olb.Server(device, "127.0.0.1", port)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18889)
    args = ap.parse_args()

    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cfg = start_server(args.port)
    time.sleep(0.3)  # let the listener bind

    checks = []

    def check(label, cond, detail=""):
        checks.append((label, bool(cond)))
        print(("  PASS " if cond else "  FAIL ") + label + ("" if cond else "  <- " + str(detail)))

    c = Client("127.0.0.1", args.port)

    # --- handshake ---
    r = c.call("Init", {"version": 2, "typeDevice": "app"}, alias="openvolley", sport="volleyball")
    check("Init handshake -> ok", r.get("status") == "ok", r)
    v = r.get("value", {})
    check("Init returns deviceName+version", v.get("deviceName") and v.get("version"), v)
    check("Init advertises noresend:false", v.get("noresend") is False, v)

    # --- happy path ---
    r = c.call("SetLayout", "volleyball_matchscore_02")
    check("SetLayout match -> ok", r.get("status") == "ok", r)

    r = c.call("SetSections", [
        *[attr("team1", "text", "WIEDIKON")], attr("team1", "color", "37,99,235"),
        attr("score1", "text", "18"), attr("score2", "text", "16"),
        attr("bg_score1", "color", "0,0,0"), attr("bg_score1", "bordercolor", "37,99,235"),
    ])
    check("SetSections WRITE shape -> ok", r.get("status") == "ok", r)

    r = c.call("SetSection", attr("score1", "text", "19"))
    check("SetSection (singular) -> ok", r.get("status") == "ok", r)

    r = c.call("GetLayout")
    check("GetLayout -> volleyball_matchscore_02", r.get("value") == "volleyball_matchscore_02", r)

    r = c.call("GetSections")
    check("GetSections returns a list", isinstance(r.get("value"), list), r)

    r = c.call("showInfo")
    check("showInfo -> ok", r.get("status") == "ok", r)
    c.call("SetLayout", "volleyball_matchscore_02")  # back to the match

    r = c.call("Horn", {"times": 2, "sleep": 0.1})
    check("Horn -> ok", r.get("status") == "ok", r)

    # --- error paths (must mirror the real device's codes) ---
    r = c.call("SetLayout", "does_not_exist")
    check("bad layout -> error 5", r.get("status") == "error" and r.get("error_code") == 5, r)

    c.call("SetLayout", "volleyball_matchscore_02")
    r = c.call("SetSections", [attr("nope", "text", "x")])
    check("unknown section -> error 6", r.get("status") == "error" and r.get("error_code") == 6, r)

    # READ shape sent to a WRITE command: value is an array of attribs -> malformed (9).
    r = c.call("SetSections", [{"name": "team1", "value": [{"attrib": "text", "value": "x"}]}])
    check("READ shape to SetSections -> error 9", r.get("status") == "error" and r.get("error_code") == 9, r)

    r = c.call("Frobnicate", {})
    check("unknown command -> error 1", r.get("status") == "error" and r.get("error_code") == 1, r)

    c.close()

    # --- render proof ---
    buf = cfg["buffer_path"]
    ok_png = os.path.exists(buf)
    dims = ""
    if ok_png and olb._HAVE_PIL:
        from PIL import Image
        with Image.open(buf) as im:
            dims = "%dx%d" % im.size
            ok_png = im.size == (cfg["width"], cfg["height"])
    check("buffer.png rendered at %dx%d" % (cfg["width"], cfg["height"]), ok_png, dims)

    passed = sum(1 for _, ok in checks if ok)
    total = len(checks)
    print("\n%d/%d checks passed" % (passed, total))
    raise SystemExit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
