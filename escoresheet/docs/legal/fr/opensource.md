# Avis open source

**OpenVolley et OpenBeach** · État au 7 octobre 2026

## OpenVolley et OpenBeach

OpenVolley et OpenBeach sont des logiciels libres. Vous pouvez les utiliser,
les diffuser et les modifier selon les termes de la **licence publique
générale GNU, version 3 ou ultérieure (GPL-3.0-or-later)**. Le logiciel est
fourni **sans aucune garantie** ; les détails figurent dans la licence.

- Texte de la licence : https://www.gnu.org/licenses/gpl-3.0.html (aussi le
  fichier `LICENSE` dans le code source)
- Code source d'OpenVolley : https://github.com/Lucanepa/openvolley
- Code source d'OpenBeach : https://github.com/Lucanepa/openbeach

Copyright © Luca Canepa et contributeurs.

## Icônes

| Icônes | Licence | Source |
|---|---|---|
| Lucide (commandes, sifflet) | ISC | https://lucide.dev/license |
| Phosphor Icons (ballon de volley) | MIT | https://github.com/phosphor-icons/react |
| flag-icons (drapeaux, OpenBeach uniquement) | MIT | https://github.com/lipis/flag-icons |

## Polices

Toutes les polices sont livrées avec les applications et ne sont pas chargées
depuis d'autres serveurs. Elles sont sous **SIL Open Font License 1.1**
(https://openfontlicense.org) :

Inter, IBM Plex Mono, JetBrains Mono, Orbitron, Roboto Mono, Space Mono
(intégrées via les paquets Fontsource).

## Bibliothèques des applications

| Paquet | Licence |
|---|---|
| React, React DOM | MIT |
| i18next, react-i18next | MIT |
| Dexie, dexie-react-hooks | Apache-2.0 |
| jsPDF | MIT |
| PDF.js (pdfjs-dist) | Apache-2.0 |
| JSZip | MIT (ou GPL-3.0-or-later) |
| fflate | MIT |
| html-to-image | MIT |
| html5-qrcode | Apache-2.0 |
| qrcode.react | ISC |
| Tailwind CSS, tailwind-merge, clsx | MIT |
| class-variance-authority | Apache-2.0 |
| ws | MIT |
| Capacitor (core, android, filesystem, screen-orientation) | MIT |

OpenBeach uniquement, en plus :

| Paquet | Licence |
|---|---|
| pdf-lib | MIT |
| read-excel-file | MIT |
| i18n-iso-countries | MIT |
| rasterizeHTML.js | MIT |

## Application de bureau

| Composant | Licence |
|---|---|
| Tauri et plugins Tauri (dialog, single-instance, updater) | Apache-2.0 ou MIT |
| tokio, axum, rust-embed, mime_guess | MIT |
| serde, serde_json, futures-util, rand, local-ip-address | MIT ou Apache-2.0 |

D'autres bibliothèques Rust sont sous MIT, Apache-2.0 ou ISC ; la liste
complète figure dans `Cargo.lock`. L'application de bureau utilise le
moteur web du système d'exploitation (WebView2 sous Windows, WebKitGTK sous
Linux) ; ceux-ci font partie du système et ne sont pas livrés avec
l'application.

## Serveur

Node.js (MIT), PostgreSQL (PostgreSQL License), pg (MIT), bcryptjs
(BSD-3-Clause), Nodemailer (MIT-0), node-ical (Apache-2.0), qrcode (MIT),
cors (MIT), ws (MIT), Caddy (Apache-2.0), cloudflared (Apache-2.0).

## Liste complète

La liste complète de tous les paquets avec leurs versions figure dans les
fichiers `package-lock.json` et `Cargo.lock` du code source. Chaque paquet
est accompagné de son texte de licence. S'il manque une indication, écrivez à
support@openvolley.app.
