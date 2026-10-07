# Avviso open source

**OpenVolley e OpenBeach** · Aggiornato al 7 ottobre 2026

## OpenVolley e OpenBeach

OpenVolley e OpenBeach sono software libero. Può usarli, distribuirli e
modificarli alle condizioni della **GNU General Public License, versione 3 o
successiva (GPL-3.0-or-later)**. Il software è fornito **senza alcuna
garanzia**; i dettagli sono nella licenza.

- Testo della licenza: https://www.gnu.org/licenses/gpl-3.0.html (anche il
  file `LICENSE` nel codice sorgente)
- Codice sorgente di OpenVolley: https://github.com/Lucanepa/openvolley
- Codice sorgente di OpenBeach: https://github.com/Lucanepa/openbeach

Copyright © Luca Canepa e collaboratori.

## Icone

| Icone | Licenza | Fonte |
|---|---|---|
| Lucide (comandi, fischietto) | ISC | https://lucide.dev/license |
| Phosphor Icons (pallone da pallavolo) | MIT | https://github.com/phosphor-icons/react |
| flag-icons (bandiere, solo OpenBeach) | MIT | https://github.com/lipis/flag-icons |

## Caratteri

Tutti i caratteri sono forniti con le app e non vengono caricati da altri
server. Sono sotto la **SIL Open Font License 1.1**
(https://openfontlicense.org):

Inter, IBM Plex Mono, JetBrains Mono, Orbitron, Roboto Mono, Space Mono
(inclusi tramite i pacchetti Fontsource).

## Librerie delle app

| Pacchetto | Licenza |
|---|---|
| React, React DOM | MIT |
| i18next, react-i18next | MIT |
| Dexie, dexie-react-hooks | Apache-2.0 |
| jsPDF | MIT |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| JSZip | MIT (o GPL-3.0-or-later) |
| fflate | MIT |
| html-to-image | MIT |
| html5-qrcode | Apache-2.0 |
| qrcode.react | ISC |
| Tailwind CSS, tailwind-merge, clsx | MIT |
| class-variance-authority | Apache-2.0 |
| ws | MIT |
| Capacitor (core, android, filesystem, screen-orientation) | MIT |

Solo OpenBeach, in aggiunta:

| Pacchetto | Licenza |
|---|---|
| pdf-lib | MIT |
| read-excel-file | MIT |
| i18n-iso-countries | MIT |
| rasterizeHTML.js | MIT |

## App desktop

| Componente | Licenza |
|---|---|
| Tauri e plugin Tauri (dialog, single-instance, updater) | Apache-2.0 o MIT |
| tokio, axum, rust-embed, mime_guess | MIT |
| serde, serde_json, futures-util, rand, local-ip-address | MIT o Apache-2.0 |

Altre librerie Rust sono sotto MIT, Apache-2.0 o ISC; l'elenco completo è in
`Cargo.lock`. L'app desktop usa il motore web del sistema operativo
(WebView2 su Windows, WebKitGTK su Linux); questi fanno parte del sistema e
non sono forniti con l'app.

## Server

Node.js (MIT), PostgreSQL (PostgreSQL License), pg (MIT), bcryptjs
(BSD-3-Clause), Nodemailer (MIT-0), node-ical (Apache-2.0), qrcode (MIT),
cors (MIT), ws (MIT), Caddy (Apache-2.0), cloudflared (Apache-2.0).

## Elenco completo

L'elenco completo di tutti i pacchetti con le versioni si trova nei file
`package-lock.json` e `Cargo.lock` del codice sorgente. Ogni pacchetto è
accompagnato dal proprio testo di licenza. Se manca un'indicazione, scriva a
support@openvolley.app.
