# ledbox-bridge has moved

The LedBox bridge now lives in its own repository and is developed there:

**https://github.com/Lucanepa/point-hub**

## Why

This directory used to be the source, with point-hub as a curated export of it. That made
point-hub *downstream*, and on 2026-08-04 a feature (structured logging + the `/logs` viewer)
was authored in the export instead of here. It was based on an older snapshot, so deploying it
would have silently reverted a day's work that existed only upstream — and the next
`deploy-board.sh` run would have overwritten it on the board regardless.

One copy, one direction. point-hub is the source of truth.

## Deploying the board

```bash
ssh lenovoserver
cd ~/repos/point-hub && git pull && bash deploy-board.sh
```

Nothing else in this monorepo imported the bridge, so removing it changes no other component.

## What deliberately did NOT move

Kept out of any public repo (both this one and point-hub are public):

- `firmware/src`, `firmware/plugin`, `firmware/libs`, `firmware/manifest.xml` — Tech4Sport's own
  firmware: decompiled sources, their plugins and their shipped `.so` binaries.
- `firmware/nota-emilio-*.md` — private correspondence with their maintainer.
- `firmware/**/wifi_qr.png` — the image encodes the board's AP passphrase, so committing it
  publishes the credential. It is derived: rebuild with `gen_qr.py` from the vault entry
  *LedBox - ledbox_C0270 WiFi (Tech4Sport)*.

Those are archived at `~/projects/ledbox-vendor-firmware/` and belong on the private Gitea,
not on GitHub.
