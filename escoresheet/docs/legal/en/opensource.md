# Open-source notice

**OpenVolley and OpenBeach** · As of 7 October 2026

## OpenVolley and OpenBeach

OpenVolley and OpenBeach are free software. You may use, share and change
them under the terms of the **GNU General Public License, version 3 or later
(GPL-3.0-or-later)**. The software is provided **without any warranty**; see
the licence for details.

- Licence text: https://www.gnu.org/licenses/gpl-3.0.html (also the file
  `LICENSE` in the source code)
- OpenVolley source code: https://github.com/Lucanepa/openvolley
- OpenBeach source code: https://github.com/Lucanepa/openbeach

Copyright © Luca Canepa and contributors.

## Icons

| Icons | Licence | Source |
|---|---|---|
| Lucide (controls, whistle) | ISC | https://lucide.dev/license |
| Phosphor Icons (volleyball) | MIT | https://github.com/phosphor-icons/react |
| flag-icons (country flags, OpenBeach only) | MIT | https://github.com/lipis/flag-icons |

## Fonts

All fonts ship with the apps and are not loaded from other servers. They are
under the **SIL Open Font License 1.1** (https://openfontlicense.org):

Inter, IBM Plex Mono, JetBrains Mono, Orbitron, Roboto Mono, Space Mono
(included through the Fontsource packages).

## Libraries in the apps

| Package | Licence |
|---|---|
| React, React DOM | MIT |
| i18next, react-i18next | MIT |
| Dexie, dexie-react-hooks | Apache-2.0 |
| jsPDF | MIT |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| JSZip | MIT (or GPL-3.0-or-later) |
| fflate | MIT |
| html-to-image | MIT |
| html5-qrcode | Apache-2.0 |
| qrcode.react | ISC |
| Tailwind CSS, tailwind-merge, clsx | MIT |
| class-variance-authority | Apache-2.0 |
| ws | MIT |
| Capacitor (core, android, filesystem, screen-orientation) | MIT |

OpenBeach only, in addition:

| Package | Licence |
|---|---|
| pdf-lib | MIT |
| read-excel-file | MIT |
| i18n-iso-countries | MIT |
| rasterizeHTML.js | MIT |

## Desktop app

| Component | Licence |
|---|---|
| Tauri and Tauri plugins (dialog, single-instance, updater) | Apache-2.0 or MIT |
| tokio, axum, rust-embed, mime_guess | MIT |
| serde, serde_json, futures-util, rand, local-ip-address | MIT or Apache-2.0 |

Further Rust libraries are under MIT, Apache-2.0 or ISC; the complete list is
in `Cargo.lock`. The desktop app uses the operating system's web view
(WebView2 on Windows, WebKitGTK on Linux); these are part of the system and
are not shipped with the app.

## Server

Node.js (MIT), PostgreSQL (PostgreSQL License), pg (MIT), bcryptjs
(BSD-3-Clause), Nodemailer (MIT-0), node-ical (Apache-2.0), qrcode (MIT),
cors (MIT), ws (MIT), Caddy (Apache-2.0), cloudflared (Apache-2.0).

## Complete list

The complete list of all packages with their versions is in the files
`package-lock.json` and `Cargo.lock` in the source code. Each package
comes with its licence text. If something is missing, write to
support@openvolley.app.
