#!/bin/bash
# KSCW LedBox watchdog.
#
# The vendor boot flow starts the app and the LED panel driver exactly once
# (rc.local -> bin/start). If either dies, the board goes dark until someone
# power-cycles it -- which, mid-match, means the scoreboard is simply gone.
#
# This keeps three things true, checking every 30s:
#   1. the scoreboard app is running
#   2. the LED panel driver (flushBuffer2) is running
#   3. the app is still PAINTING -- www/buffer.png is rewritten every frame
#      (~5 fps), so a stale file means the render thread died even though the
#      process is alive and still answering on port 8889. That failure is
#      invisible from the network: the bridge still reports "connected" while
#      the panel is frozen on the last frame.
#
# Restarting is always preferred over rebooting: a restart costs ~10s, a reboot
# costs ~60s and drops the wifi AP with it.

BUFFER=/home/pi/ledbox/www/buffer.png
STALE_AFTER=60      # seconds without a repaint before we call the renderer dead
CHECK_EVERY=30

log() { logger -t ledbox-watchdog "$1"; echo "$(date '+%F %T') $1"; }

app_running()   { pgrep -f "python3 -u ledbox.py" >/dev/null 2>&1; }
panel_running() { pgrep -f "bin/flushBuffer2" >/dev/null 2>&1; }

start_app() { ( cd /home/pi/ledbox/bin && ./startledbox >/dev/null 2>&1 & ) ; }
start_panel() { ( cd /home/pi/ledbox/bin && ./startled >/dev/null 2>&1 & ) ; }

# Let the normal boot sequence finish before policing it.
sleep 90
log "watchdog started"

while true; do
    if ! app_running; then
        log "app not running -> starting"
        start_app
        sleep 25          # give it time to bind its sockets before re-checking
    elif [ -f "$BUFFER" ]; then
        age=$(( $(date +%s) - $(stat -c %Y "$BUFFER" 2>/dev/null || date +%s) ))
        if [ "$age" -gt "$STALE_AFTER" ]; then
            log "panel frozen (buffer.png ${age}s old) -> restarting app"
            pkill -f "python3 -u ledbox.py"
            sleep 3
            start_app
            sleep 25
        fi
    fi

    # Checked after the app: startledbox also brings the panel up, so this
    # avoids racing it during a restart.
    if ! panel_running; then
        log "panel driver not running -> starting"
        start_panel
        sleep 10
    fi

    sleep "$CHECK_EVERY"
done
