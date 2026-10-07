# Open-Source-Hinweis

**OpenVolley und OpenBeach** · Stand: 7. Oktober 2026

## OpenVolley und OpenBeach

OpenVolley und OpenBeach sind freie Software. Sie dürfen sie unter den
Bedingungen der **GNU General Public License, Version 3 oder später
(GPL-3.0-or-later)** nutzen, weitergeben und verändern. Die Software wird
**ohne jede Gewährleistung** bereitgestellt; Einzelheiten stehen in der
Lizenz.

- Lizenztext: https://www.gnu.org/licenses/gpl-3.0.html (auch als Datei
  `LICENSE` im Quellcode)
- Quellcode OpenVolley: https://github.com/Lucanepa/openvolley
- Quellcode OpenBeach: https://github.com/Lucanepa/openbeach

Copyright © Luca Canepa und Mitwirkende.

## Symbole

| Symbole | Lizenz | Quelle |
|---|---|---|
| Lucide (Bedienelemente, Pfeife) | ISC | https://lucide.dev/license |
| Phosphor Icons (Volleyball) | MIT | https://github.com/phosphor-icons/react |
| flag-icons (Länderflaggen, nur OpenBeach) | MIT | https://github.com/lipis/flag-icons |

## Schriften

Alle Schriften werden mit den Apps ausgeliefert und nicht von fremden Servern
geladen. Sie stehen unter der **SIL Open Font License 1.1**
(https://openfontlicense.org):

Inter, IBM Plex Mono, JetBrains Mono, Orbitron, Roboto Mono, Space Mono
(eingebunden über die Pakete von Fontsource).

## Bibliotheken der Apps

| Paket | Lizenz |
|---|---|
| React, React DOM | MIT |
| i18next, react-i18next | MIT |
| Dexie, dexie-react-hooks | Apache-2.0 |
| jsPDF | MIT |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| JSZip | MIT (oder GPL-3.0-or-later) |
| fflate | MIT |
| html-to-image | MIT |
| html5-qrcode | Apache-2.0 |
| qrcode.react | ISC |
| Tailwind CSS, tailwind-merge, clsx | MIT |
| class-variance-authority | Apache-2.0 |
| ws | MIT |
| Capacitor (core, android, filesystem, screen-orientation) | MIT |

Nur OpenBeach zusätzlich:

| Paket | Lizenz |
|---|---|
| pdf-lib | MIT |
| read-excel-file | MIT |
| i18n-iso-countries | MIT |
| rasterizeHTML.js | MIT |

## Desktop-App

| Komponente | Lizenz |
|---|---|
| Tauri und Tauri-Plugins (dialog, single-instance, updater) | Apache-2.0 oder MIT |
| tokio, axum, rust-embed, mime_guess | MIT |
| serde, serde_json, futures-util, rand, local-ip-address | MIT oder Apache-2.0 |

Weitere Rust-Bibliotheken stehen unter MIT, Apache-2.0 oder ISC; die
vollständige Liste steht in `Cargo.lock`. Die Desktop-App nutzt die
Web-Ansicht des Betriebssystems (WebView2 unter Windows, WebKitGTK unter
Linux); diese gehören zum System und werden nicht mitgeliefert.

## Server

Node.js (MIT), PostgreSQL (PostgreSQL License), pg (MIT), bcryptjs
(BSD-3-Clause), Nodemailer (MIT-0), node-ical (Apache-2.0), qrcode (MIT),
cors (MIT), ws (MIT), Caddy (Apache-2.0), cloudflared (Apache-2.0).

## Vollständige Liste

Die vollständige Liste aller Pakete mit Versionen steht in den Dateien
`package-lock.json` und `Cargo.lock` im Quellcode. Die Lizenztexte der
einzelnen Pakete liegen den Paketen bei. Wenn Sie eine Angabe vermissen,
schreiben Sie an support@openvolley.app.
