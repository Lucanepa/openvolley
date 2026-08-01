#!/usr/bin/env bash
# Reproducible build of flushBuffer2 — the open rebuild of the Tech4Sport
# flushBuffer (see README.md). Run on the armhf board, or any armhf Pi with
# g++/make. Needs internet for the two source fetches; if the board has none,
# fetch them on a jump host and drop rgbmatrix.tar.gz + stb_image.h into $WORK.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-/home/pi/flushBuffer-rebuild}"
RGB_URL="https://codeload.github.com/hzeller/rpi-rgb-led-matrix/tar.gz/refs/heads/master"
STB_URL="https://raw.githubusercontent.com/nothings/stb/master/stb_image.h"

mkdir -p "$WORK" && cd "$WORK"
[ -f rgbmatrix.tar.gz ]            || curl -sL "$RGB_URL" -o rgbmatrix.tar.gz
[ -d rpi-rgb-led-matrix-master ]  || tar xzf rgbmatrix.tar.gz
SRC="$WORK/rpi-rgb-led-matrix-master"
[ -f "$SRC/stb_image.h" ]         || curl -sL "$STB_URL" -o "$SRC/stb_image.h"
cp "$HERE/flushbuffer.cc" "$SRC/flushbuffer.cc"

# Add the custom `applicon` GPIO mapping: stock `regular` with the E-line on
# GPIO26 instead of GPIO15 (recovered from the unstripped vendor binary).
python3 - "$SRC/lib/hardware-mapping.c" <<'PY'
import re, sys
HM = sys.argv[1]; s = open(HM).read()
if '"applicon"' in s:
    print("applicon mapping already present"); raise SystemExit
i = s.index('"regular"'); ob = s.rfind('{', 0, i)
d = 0; j = ob
while j < len(s):
    c = s[j]
    if c == '{': d += 1
    elif c == '}':
        d -= 1
        if d == 0: break
    j += 1
block = s[ob:j+1]
appl = re.sub(r'(\.e\s*=\s*)GPIO_BIT\(15\)', r'\1GPIO_BIT(26)',
              block.replace('"regular"', '"applicon"'))
k = s.find(',', j)
open(HM, 'w').write(s[:k+1] + "\n\n  " + appl + "," + s[k+1:])
print("added applicon mapping (e=GPIO26)")
PY

make -C "$SRC/lib" -j"$(nproc)"
cd "$SRC"
g++ -I include -I . -O3 -Wall -Wextra -Wno-unused-parameter -std=c++11 \
    -c -o flushbuffer.o flushbuffer.cc
g++ -o flushBuffer2 flushbuffer.o -L lib -lrgbmatrix -lrt -lm -lpthread
echo "built: $SRC/flushBuffer2"
file "$SRC/flushBuffer2"
echo "--- linked libraries (must be stock only) ---"
ldd "$SRC/flushBuffer2"
