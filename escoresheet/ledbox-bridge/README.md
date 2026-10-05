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

See point-hub's README (`deploy-board.sh`).

Nothing else in this monorepo imported the bridge, so removing it changes no other component.

## What deliberately did NOT move

Kept out of any public repo (both this one and point-hub are public):

- The board vendor's own firmware: decompiled sources, plugins, shipped binaries and firmware
  archives.
- Private correspondence with the vendor.
- Wi-Fi QR images and any other file that holds the board's AP passphrase. They are derived:
  regenerate them from the password manager and never commit them.

Those live in private storage, not on GitHub. Everything in this directory except this README
is gitignored (`escoresheet/.gitignore`), so leftovers in an old checkout cannot be committed
by accident.
