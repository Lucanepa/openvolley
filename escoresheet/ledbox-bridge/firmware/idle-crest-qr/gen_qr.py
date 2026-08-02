#!/usr/bin/env python3
"""Regenerate the idle-screen QR PNGs (wifi_qr.png + ui_qr.png).

The board firmware shows these on the crest idle screen (see waiting.xml /
32_kscw_crest.xml). They are plain 48x48 dark-on-white QR codes, forced to QR
**version 3** (29x29 modules) so both render at the same density, with a small
white quiet zone baked in (the panel background is dark, so the quiet zone MUST
live inside the PNG or scanners lose the finder pattern edges).

    python3 gen_qr.py --wifi-pass PASS                    # -> ./media/{wifi,ui}_qr.png
    python3 gen_qr.py --wifi-pass PASS --outdir /tmp/x    # preview elsewhere first

Deps: qrcode + Pillow (`pip install qrcode pillow`). There is NO qrcode lib on
the board, so generate here and scp media/*.png to /home/pi/ledbox/media/.
This script is the encoder the earlier session hand-rolled and did not save.
"""
import argparse
import os

import qrcode
from qrcode.constants import ERROR_CORRECT_M
from PIL import Image

SSID = "ledbox_C0270"
UI_URL = "http://172.24.1.1:8890"
SIZE = 48       # px, matches width/height in the layout <section type="image">
QUIET = 3       # px white border (baked-in quiet zone)
VERSION = 3     # 29x29 modules; v3-M byte capacity = 53 chars


def render(data, path):
    qr = qrcode.QRCode(version=VERSION, error_correction=ERROR_CORRECT_M, border=0)
    qr.add_data(data)
    qr.make(fit=True)               # stays v3 while data <= 53 bytes
    m = qr.get_matrix()
    n = len(m)                      # 29 for version 3
    avail = SIZE - 2 * QUIET
    img = Image.new("RGB", (SIZE, SIZE), "white")
    px = img.load()
    for y in range(SIZE):
        for x in range(SIZE):
            mx, my = x - QUIET, y - QUIET
            if 0 <= mx < avail and 0 <= my < avail and m[(my * n) // avail][(mx * n) // avail]:
                px[x, y] = (0, 0, 0)
    img.save(path)
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wifi-pass", required=True,
                    help="WPA passphrase to encode in wifi_qr.png (must match hostapd.conf). "
                         "Required on purpose — no secret is baked into this script.")
    ap.add_argument("--outdir",
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "media"))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    wifi = f"WIFI:T:WPA;S:{SSID};P:{a.wifi_pass};;"
    n1 = render(wifi, os.path.join(a.outdir, "wifi_qr.png"))
    n2 = render(UI_URL, os.path.join(a.outdir, "ui_qr.png"))
    print(f"wifi_qr.png  v{VERSION} {n1}x{n1} modules  data={wifi!r}")
    print(f"ui_qr.png    v{VERSION} {n2}x{n2} modules  data={UI_URL!r}")


if __name__ == "__main__":
    main()
