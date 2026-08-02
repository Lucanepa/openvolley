#!/usr/bin/env python3
"""
openscore — a clean, open-source replacement for the Tech4Sport LedBox firmware.

WHY
    The board's stock firmware (`/home/pi/ledbox/ledbox.py` & friends) is Tech4Sport's
    PROPRIETARY app, decompiled with uncompyle6 and hand-ported to Python 3. It is the
    only closed/legally-grey layer left in the stack. This module replaces it outright,
    so the whole scoreboard is open:

        control UI + bridge (open) -> openscore.py (open) -> flushBuffer2 (open) -> panel

HOW IT FITS
    openscore speaks the exact same TCP :8889 gzip/JSON protocol the bridge already
    uses, keeps the same layout XML format (layout/*.xml, layout/system/*.xml), renders
    the current layout to `www/buffer.png` with Pillow, and lets the already-verified,
    open `flushBuffer2` (hzeller/rpi-rgb-led-matrix + stb_image) push that PNG to the
    physical panel — exactly the render->PNG->panel split the stock firmware used, minus
    the proprietary renderer.

BETTER / LESS ERROR-PRONE THAN THE VENDOR FIRMWARE
    * Clean client lifecycle: when a client dies without disconnecting, the port does NOT
      wedge (the documented stock bug where :8889 stays closed for ~80s until a power
      cycle). We drop the dead socket at once and go back to accepting + showing idle.
    * `noresend` is OFF: we always reply, so the bridge never stalls waiting out a 5 s
      timeout on a "silent" SetLayout to the current layout.
    * Robust layout loading: globs *.xml and uses os.path.splitext — it can't be crashed
      by a stray file in the layout folder (the `f.split('.')` foot-gun).
    * Shrink-to-fit text: long club names scale down to fit their box instead of clipping
      (the stock `fontsize` lever couldn't do this).
    * UTF-8 throughout (umlauts survive); structured logging; no serial/BT/plugin cruft.

STATUS
    Untested on the physical panel. Rendering can be validated headless (writes buffer.png
    with no GPIO). Deploy + on-panel calibration is the remaining step — see README.md.
"""

import argparse
import configparser
import glob
import gzip
import json
import logging
import os
import socket
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass, field

try:
    from PIL import Image, ImageDraw, ImageFont
    _HAVE_PIL = True
except ImportError:  # rendering unavailable; server still runs (useful for protocol tests)
    _HAVE_PIL = False

log = logging.getLogger("openscore")

# --------------------------------------------------------------------------------------
# Wire protocol — gzip'd JSON, {cmd, value} -> {status, sender, value}. One gzip member
# per message (self-delimiting via the ISIZE footer), matching src/ledboxProtocol.js.
# --------------------------------------------------------------------------------------

def encode(obj) -> bytes:
    return gzip.compress(json.dumps(obj).encode("utf-8"), compresslevel=1)


class StreamDecoder:
    """Accumulate stream bytes; yield each fully-decoded JSON message. A gzip member that
    hasn't fully arrived yet is left buffered until the next chunk completes it."""

    def __init__(self):
        self._buf = b""

    def push(self, chunk: bytes):
        self._buf += chunk
        out = []
        while self._buf:
            d = zlib.decompressobj(31)  # 31 = gzip
            try:
                data = d.decompress(self._buf) + d.flush()
            except zlib.error:
                # Not a valid/complete member yet. If we're clearly desynced (no gzip
                # magic), resync on the next 0x1f; otherwise wait for more bytes.
                if self._buf[:1] != b"\x1f":
                    nxt = self._buf.find(b"\x1f", 1)
                    self._buf = b"" if nxt == -1 else self._buf[nxt:]
                    continue
                break
            if not d.eof:  # member incomplete — need more bytes
                break
            try:
                out.append(json.loads(data.decode("utf-8")))
            except (ValueError, UnicodeDecodeError):
                pass
            self._buf = d.unused_data
        return out


def _ok(sender, value=True):
    return {"status": "ok", "sender": sender, "value": value}


def _err(sender, code, message):
    return {"status": "error", "sender": sender, "error_code": code, "error_message": message}


def _preview(value, limit=200):
    """Short, safe one-line preview of a command's value, for the per-command log line."""
    try:
        s = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        s = str(value)
    return s if len(s) <= limit else s[:limit] + "…"


def _local_ips():
    """Best-effort list of this host's non-loopback IPv4 addresses (stdlib only)."""
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    if not ips:
        # Fall back to the address used to reach a public IP (no packets are sent).
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ips.append(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    return ips


# --------------------------------------------------------------------------------------
# Layout model — same XML the stock firmware ships (layout/*.xml, layout/system/*.xml).
# --------------------------------------------------------------------------------------

def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _to_rgb(s, default=(255, 255, 255)):
    if not s:
        return default
    parts = str(s).replace(";", ",").split(",")
    try:
        r, g, b = (int(p) for p in parts[:3])
        return (r, g, b)
    except ValueError:
        return default


def _to_bool(s, default=True):
    if s is None:
        return default
    return str(s).strip().lower() not in ("false", "0", "no", "")


@dataclass
class Section:
    name: str = ""
    type: str = "text"
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0
    align: str = "left"
    valign: str = "top"
    color: tuple = (255, 255, 255)
    bordercolor: tuple = None
    text: str = ""
    src: str = ""
    fontsize: int = 0
    visible: bool = True
    private: bool = False


@dataclass
class Layout:
    name: str
    modifier: str = ""
    sections: list = field(default_factory=list)

    def get(self, name):
        for s in self.sections:
            if s.name == name:
                return s
        return None


def _parse_layout(path) -> Layout:
    root = ET.parse(path).getroot()
    lay = Layout(name=root.attrib.get("name", ""), modifier=root.attrib.get("modifier", ""))
    for child in root:
        a = child.attrib
        s = Section(
            name=a.get("name", ""),
            type=a.get("type", "text"),
            x=_to_int(a.get("x")),
            y=_to_int(a.get("y")),
            width=_to_int(a.get("width")),
            height=_to_int(a.get("height")),
            align=a.get("align", "left"),
            valign=a.get("valign", "top"),
            color=_to_rgb(a.get("color")),
            bordercolor=_to_rgb(a.get("bordercolor")) if "bordercolor" in a else None,
            src=a.get("src", ""),
            fontsize=_to_int(a.get("fontsize")),
            visible=_to_bool(a.get("visible")),
            private=_to_bool(a.get("private"), default=False),
            text=(child.text or "").strip(),
        )
        lay.sections.append(s)
    return lay


def load_layouts(layout_dir) -> dict:
    """Robustly load every *.xml under layout/ and layout/system/. A malformed or oddly
    named file is skipped with a warning — never crashes the load (unlike the stock
    `filename, extension = f.split('.')`)."""
    layouts = {}
    dirs = [layout_dir, os.path.join(layout_dir, "system")]
    for d in dirs:
        for path in sorted(glob.glob(os.path.join(d, "*.xml"))):
            if not os.path.isfile(path):
                continue
            try:
                lay = _parse_layout(path)
            except Exception as e:  # noqa: BLE001 - one bad file must not sink the rest
                log.warning("skipping unparseable layout %s: %s", path, e)
                continue
            # First definition wins on name; both `name=` attr and bare filename resolve.
            layouts.setdefault(lay.name, lay)
            layouts.setdefault(os.path.splitext(os.path.basename(path))[0], lay)
    return layouts


# --------------------------------------------------------------------------------------
# Renderer — sections -> 192x64 RGB image -> www/buffer.png (atomic). flushBuffer2 polls
# the PNG and drives the panel; we never touch GPIO here.
# --------------------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
# Bundled Liberation Sans (metric-compatible with the vendor board's Arial) makes rendering
# faithful AND self-contained; system fonts are only a fallback for a bare checkout.
_FONT_CANDIDATES = [
    os.path.join(_HERE, "fonts", "LiberationSans-Regular.ttf"),
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


class Renderer:
    def __init__(self, width, height, buffer_path, base_dir, font_path=None):
        self.width = width
        self.height = height
        self.buffer_path = buffer_path
        self.base_dir = base_dir
        # Make sure the frame's directory exists so the atomic os.replace() can land it
        # (flushBuffer2 polls this path). A fresh checkout has no www/ yet.
        os.makedirs(os.path.dirname(os.path.abspath(buffer_path)), exist_ok=True)
        self._font_path = font_path or next((p for p in _FONT_CANDIDATES if os.path.exists(p)), None)
        self._font_cache = {}
        self._img_cache = {}

    def _font(self, size):
        size = max(6, int(size) or 12)
        if size not in self._font_cache:
            if self._font_path and _HAVE_PIL:
                self._font_cache[size] = ImageFont.truetype(self._font_path, size)
            else:
                self._font_cache[size] = ImageFont.load_default()
        return self._font_cache[size]

    def _anchor(self, align, valign):
        h = {"left": "l", "center": "m", "middle": "m", "right": "r"}.get(align, "l")
        v = {"top": "a", "middle": "m", "center": "m", "bottom": "d"}.get(valign, "a")
        return h + v

    def _fit_font(self, draw, text, size, box_w):
        """Shrink the font until `text` fits `box_w` (min 6px). box_w<=0 means no limit."""
        font = self._font(size)
        if box_w and box_w > 0 and text:
            while size > 6:
                w = draw.textlength(text, font=font)
                if w <= box_w:
                    break
                size -= 1
                font = self._font(size)
        return font

    def _load_image(self, src):
        path = src if os.path.isabs(src) else os.path.join(self.base_dir, src)
        if not os.path.exists(path):
            # An absent image is an expected, non-fatal case (e.g. a layout that ships a
            # media placeholder the operator hasn't uploaded, or the blanked vendor banner).
            # Skip it quietly rather than raising into the section-level warning path.
            log.debug("image not found, skipping: %s", path)
            return None
        mtime = os.path.getmtime(path)
        key = (path, mtime)
        if key not in self._img_cache:
            self._img_cache.clear()
            self._img_cache[key] = Image.open(path).convert("RGBA")
        return self._img_cache[key]

    def render(self, layout: Layout):
        if not _HAVE_PIL:
            return
        img = Image.new("RGB", (self.width, self.height), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        for s in (layout.sections if layout else []):
            if not s.visible:
                continue
            try:
                if s.type == "text":
                    self._draw_text(draw, s)
                elif s.type == "image":
                    self._draw_image(img, s)
                elif s.type == "rectangle":
                    self._draw_rect(draw, s)
                elif s.type in ("circle", "ellipse"):
                    self._draw_circle(draw, s)
                elif s.type == "bar":
                    self._draw_bar(draw, s)
            except Exception as e:  # noqa: BLE001 - a bad section must not blank the board
                log.warning("render error on section %s: %s", s.name, e)
        self._save(img)

    def _draw_text(self, draw, s):
        if not s.text:
            return
        font = self._fit_font(draw, s.text, s.fontsize or 12, s.width)
        draw.text((s.x, s.y), s.text, fill=s.color, font=font, anchor=self._anchor(s.align, s.valign))

    def _draw_image(self, img, s):
        if not s.src:
            return
        src = self._load_image(s.src)
        if src is None:
            return
        bw = s.width or src.width
        bh = s.height or src.height
        scale = min(bw / src.width, bh / src.height)
        w, h = max(1, int(src.width * scale)), max(1, int(src.height * scale))
        src = src.resize((w, h), Image.LANCZOS)
        # position the (scaled) image inside its x,y,box per align/valign
        ax = {"left": 0, "center": (bw - w) // 2, "middle": (bw - w) // 2, "right": bw - w}.get(s.align, 0)
        ay = {"top": 0, "middle": (bh - h) // 2, "center": (bh - h) // 2, "bottom": bh - h}.get(s.valign, 0)
        img.paste(src, (s.x + ax, s.y + ay), src)

    def _draw_rect(self, draw, s):
        x0, y0, x1, y1 = s.x, s.y, s.x + max(1, s.width), s.y + max(1, s.height)
        fill = s.color if s.bordercolor is None else (s.color if s.color != (0, 0, 0) else None)
        outline = s.bordercolor
        draw.rectangle([x0, y0, x1, y1], fill=fill, outline=outline)

    def _draw_circle(self, draw, s):
        # A `circle`/`ellipse` section (e.g. the tennis layout's serve dots). Filled with
        # `color`, outlined in `bordercolor` if present — same fill/outline rules as a rect.
        x0, y0, x1, y1 = s.x, s.y, s.x + max(1, s.width), s.y + max(1, s.height)
        fill = s.color if s.bordercolor is None else (s.color if s.color != (0, 0, 0) else None)
        draw.ellipse([x0, y0, x1, y1], fill=fill, outline=s.bordercolor)

    def _draw_bar(self, draw, s):
        # A `bar` is a proportional fill: `bordercolor` draws the track outline, `color` fills
        # a fraction of it. The fraction is read from the section's text (0..100 percent, or
        # 0..1); empty/non-numeric text fills the whole bar. Horizontal when wider than tall,
        # vertical otherwise. Provisional shape — no shipped layout uses `bar` yet, so this is
        # forward-compatible and will be calibrated against hardware if one ever does.
        w, h = max(1, s.width), max(1, s.height)
        try:
            frac = float(str(s.text).strip()) if str(s.text).strip() else 1.0
        except ValueError:
            frac = 1.0
        if frac > 1.0:
            frac = frac / 100.0
        frac = max(0.0, min(1.0, frac))
        if s.bordercolor is not None:
            draw.rectangle([s.x, s.y, s.x + w, s.y + h], outline=s.bordercolor)
        if frac > 0:
            if w >= h:  # horizontal — grow rightwards
                draw.rectangle([s.x, s.y, s.x + int(w * frac), s.y + h], fill=s.color)
            else:       # vertical — grow upwards from the bottom
                top = s.y + int(h * (1.0 - frac))
                draw.rectangle([s.x, top, s.x + w, s.y + h], fill=s.color)

    def _save(self, img):
        tmp = self.buffer_path + ".tmp"
        img.save(tmp, "PNG")
        os.replace(tmp, self.buffer_path)  # atomic — flushBuffer2 never sees a half-written frame


# --------------------------------------------------------------------------------------
# Device — layout/section state + command handling. One source of truth; the server just
# feeds it decoded commands and returns replies.
# --------------------------------------------------------------------------------------

class Device:
    def __init__(self, cfg, renderer):
        self.cfg = cfg
        self.renderer = renderer
        self.layouts = load_layouts(cfg["layout_dir"])
        self.device_name = cfg["device_name"]
        self.version = cfg["version"]
        self.idle_layout = cfg["idle_layout"]
        self.current = None
        # RLock, not Lock: handle() holds the lock and then calls show_idle()/show_info()
        # for Clear/StopAllProcess/showInfo, which re-acquire it. A plain Lock deadlocks
        # the client thread on those commands; RLock lets the same thread re-enter.
        self._lock = threading.RLock()
        self.show_idle()

    # ---- rendering helpers ----
    def _set_current(self, name):
        lay = self.layouts.get(name)
        if lay is None:
            return None
        self.current = lay
        self.renderer.render(lay)
        return lay

    def show_idle(self):
        with self._lock:
            if self._set_current(self.idle_layout) is None:
                # fall back to a blank frame if the idle layout is missing
                self.current = Layout(name="__blank__")
                self.renderer.render(self.current)

    def show_info(self):
        """Paint the network-info screen the vendor board flashes at boot: device name,
        every local IPv4, the control port and the firmware version. Built procedurally as
        an ad-hoc text Layout (no XML needed), so it works on any deployment."""
        ips = _local_ips()
        w = self.renderer.width
        lines = [
            (self.device_name, (255, 200, 50)),
            ("IP " + (", ".join(ips) if ips else "?"), (255, 255, 255)),
            ("port %d" % self.cfg.get("port", 8889), (150, 150, 150)),
            ("fw %s" % self.version, (150, 150, 150)),
        ]
        lay = Layout(name="__info__")
        y = 0
        for txt, col in lines:
            lay.sections.append(Section(name="info", type="text", x=2, y=y, width=w - 4,
                                        align="left", valign="top", color=col,
                                        fontsize=13, text=txt))
            y += 16
        with self._lock:
            self.current = lay
            self.renderer.render(lay)

    # ---- command dispatch (mirrors what the bridge sends) ----
    def handle(self, msg):
        cmd = msg.get("cmd")
        value = msg.get("value")
        log.info("cmd %s %s", cmd, _preview(value))
        with self._lock:
            if cmd == "Init":
                return _ok("Init", {
                    "deviceName": self.device_name,
                    "version": self.version,
                    "role": "admin",
                    "current_layout": self.current.name if self.current else "",
                    "plugins": [],
                    "noresend": False,  # we always reply -> no client stalls
                })
            if cmd == "Info":
                # Bridge/mock contract: return device identity. Does NOT change the screen
                # (a poll must not clobber a live scoreboard). Use showInfo to paint it.
                return _ok("Info", {"deviceName": self.device_name, "version": self.version})
            if cmd in ("showInfo", "ShowInfo"):
                # The board's boot "network info" screen: hostname / IP(s) / port / version.
                self.show_info()
                return _ok(cmd, True)
            if cmd == "SetLayout":
                name = value if isinstance(value, str) else (value or {}).get("value")
                if self._set_current(name) is None:
                    return _err("SetLayout", 5, "layout not present in device")
                return _ok("SetLayout", name)
            if cmd == "ReloadLayout":
                name = value if isinstance(value, str) else (value or {}).get("value")
                if not name:
                    return _err("ReloadLayout", 5, "layout not present in device")
                self.layouts = load_layouts(self.cfg["layout_dir"])  # re-read from disk
                if self._set_current(name) is None:
                    return _err("ReloadLayout", 5, "layout not present in device")
                return _ok("ReloadLayout", name)
            if cmd in ("SetSections", "SetSection"):
                return self._set_sections(cmd, value)
            if cmd == "GetLayout":
                return _ok("GetLayout", self.current.name if self.current else "")
            if cmd == "GetSections":
                return _ok("GetSections", self._read_sections())
            if cmd == "Horn":
                self._horn(value or {})
                return _ok("Horn", True)
            if cmd in ("Clear", "StopAllProcess"):
                self.show_idle()
                return _ok(cmd, True)
            if cmd == "ChangeWaiting":
                return _ok("ChangeWaiting", {**(value or {}), "exist": False})
            if cmd == "Disconnect":
                return _ok("Disconnect", True)
            # Unknown commands fail cleanly, exactly like the device (error 1).
            return _err(cmd or "?", 1, "API not avaible")

    def _set_sections(self, cmd, value):
        if self.current is None:
            return _err(cmd, 5, "no layout loaded")
        entries = value if isinstance(value, list) else [value]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            sec = self.current.get(entry.get("name"))
            if sec is None:
                return _err(cmd, 6, "section %s not found" % entry.get("name"))
            av = entry.get("value")
            # WRITE shape is exactly ONE {attrib, value} object per entry. A LIST is the
            # GetSections READ shape, and the real device rejects it with error 9 ("key
            # 'attrib' in section <name> not defined") — the single easiest thing to get
            # wrong (PROTOCOL.md). Enforce it so the bridge fails identically here and on hw.
            if not isinstance(av, dict) or "attrib" not in av:
                return _err(cmd, 9, "key 'attrib' in section %s not defined" % sec.name)
            self._apply_attrib(sec, av["attrib"], av.get("value"))
        self.renderer.render(self.current)
        return _ok(cmd, True)

    @staticmethod
    def _apply_attrib(sec, attrib, val):
        if attrib == "text":
            sec.text = "" if val is None else str(val)
        elif attrib == "color":
            sec.color = _to_rgb(val)
        elif attrib == "bordercolor":
            sec.bordercolor = _to_rgb(val)
        elif attrib == "src":
            sec.src = "" if val is None else str(val)
        elif attrib == "fontsize":
            sec.fontsize = _to_int(val, sec.fontsize)
        elif attrib == "visible":
            sec.visible = _to_bool(val)

    def _read_sections(self):
        out = []
        for s in (self.current.sections if self.current else []):
            if s.private:
                continue
            out.append({"name": s.name, "value": [
                {"attrib": "text", "value": s.text},
                {"attrib": "color", "value": "%d,%d,%d" % s.color},
            ]})
        return out

    def _horn(self, value):
        times = _to_int(value.get("times"), 1) if isinstance(value, dict) else 1
        gap = value.get("sleep", 0.5) if isinstance(value, dict) else 0.5
        cmd = self.cfg.get("horn_cmd")
        if not cmd:
            return

        def beep():
            for i in range(max(1, times)):
                try:
                    subprocess.Popen(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception as e:  # noqa: BLE001
                    log.warning("horn failed: %s", e)
                    return
                if i < times - 1:
                    time.sleep(float(gap) if gap else 0.5)

        threading.Thread(target=beep, daemon=True).start()


# --------------------------------------------------------------------------------------
# TCP server — one client at a time, but NEVER wedges the port when a client dies.
# --------------------------------------------------------------------------------------

class Server:
    def __init__(self, device, host, port):
        self.device = device
        self.host = host
        self.port = port
        self._client_lock = threading.Lock()
        self._client = None

    def serve_forever(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind((self.host, self.port))
        srv.listen(5)
        log.info("openscore listening on %s:%d", self.host, self.port)
        while True:
            conn, addr = srv.accept()
            # A new client supersedes any previous one; the stale socket is dropped so the
            # service can never get stuck holding a dead session (the vendor's port-wedge bug).
            with self._client_lock:
                old = self._client
                self._client = conn
            if old is not None:
                try:
                    old.close()
                except OSError:
                    pass
            threading.Thread(target=self._handle_client, args=(conn, addr), daemon=True).start()

    def _handle_client(self, conn, addr):
        log.info("client connected: %s", addr)
        conn.settimeout(90)  # a silent/dead client is reaped rather than held forever
        decoder = StreamDecoder()
        try:
            while True:
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    log.info("client %s idle-timed out", addr)
                    break
                if not chunk:
                    break
                for msg in decoder.push(chunk):
                    reply = self.device.handle(msg)
                    if reply is not None:
                        conn.sendall(encode(reply))
                    if msg.get("cmd") == "Disconnect":
                        raise _Done()
        except (_Done, OSError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass
            with self._client_lock:
                if self._client is conn:
                    self._client = None
                    self.device.show_idle()  # no client -> back to the idle/crest screen
            log.info("client disconnected: %s", addr)


class _Done(Exception):
    pass


# --------------------------------------------------------------------------------------
# Config + entry point
# --------------------------------------------------------------------------------------

def build_config(base_dir):
    ini = configparser.ConfigParser()
    ini.read([os.path.join(base_dir, "setting.ini")])
    user = configparser.ConfigParser()
    user.read([os.path.join(base_dir, "user_setting.ini")])

    def geti(section, key, default):
        try:
            return ini.getint(section, key)
        except (configparser.Error, ValueError):
            return default

    version = "openscore-1.0.0"
    manifest = os.path.join(base_dir, "manifest.xml")
    if os.path.exists(manifest):
        try:
            for c in ET.parse(manifest).getroot():
                if c.tag == "version" and c.text:
                    version = "openscore-" + c.text.strip()
        except ET.ParseError:
            pass

    device_name = "OpenScore"
    if user.has_option("GENERAL", "device"):
        device_name = user.get("GENERAL", "device")

    return {
        "base_dir": base_dir,
        "layout_dir": os.path.join(base_dir, "layout"),
        "buffer_path": os.path.join(base_dir, "www", "buffer.png"),
        "width": geti("DISPLAY", "width", 192),
        "height": geti("DISPLAY", "height", 64),
        "device_name": device_name,
        "version": version,
        "idle_layout": "waiting",
        "port": geti("TCP", "port", 8889),
        "horn_cmd": ("aplay -q %s" % os.path.join(base_dir, "back.wav"))
        if os.path.exists(os.path.join(base_dir, "back.wav")) else None,
    }


def main():
    ap = argparse.ArgumentParser(description="Open-source LedBox firmware")
    ap.add_argument("--base-dir", default=os.path.dirname(os.path.abspath(__file__)),
                    help="firmware dir holding layout/, www/, setting.ini (default: this dir)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--font", default=None, help="TTF font path (default: DejaVuSans-Bold if present)")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = build_config(args.base_dir)
    if args.port:
        cfg["port"] = args.port

    if not _HAVE_PIL:
        log.warning("Pillow not installed — running protocol-only (no buffer.png rendering)")

    renderer = Renderer(cfg["width"], cfg["height"], cfg["buffer_path"], cfg["base_dir"], args.font)
    device = Device(cfg, renderer)
    Server(device, args.host, cfg["port"]).serve_forever()


if __name__ == "__main__":
    main()
