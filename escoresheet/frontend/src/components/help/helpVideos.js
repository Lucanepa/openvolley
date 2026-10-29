// The help's recorded videos (helpSections.js sectionVideo), one per section:
// the title in each language, the length in seconds, the picture size and
// the subtitle languages. A section that is not listed has no video yet and
// the panel shows none. The files are on openvolley.app/support/videos.
// Written by scripts/import-help-videos.mjs from the recorder's manifest
// (OpenVolley 3.0.6, 29.10.2026); do not edit by hand. Plain data: node reads it too.

export const HELP_VIDEOS = {
  home: { title: { en: 'Home', de: 'Startseite', fr: 'Accueil', it: 'Home' }, durationSec: 54.8, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  setup: { title: { en: 'Match setup', de: 'Spiel einrichten', fr: 'Préparer le match', it: 'Preparare la partita' }, durationSec: 50.5, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  'coin-toss': { title: { en: 'Coin toss and line-ups', de: 'Auslosung und Aufstellung', fr: 'Tirage au sort et compositions', it: 'Sorteggio e formazioni' }, durationSec: 70.1, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  scoring: { title: { en: 'Scoring', de: 'Punkte erfassen', fr: 'Marquer les points', it: 'Segnare i punti' }, durationSec: 49.2, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  'subs-timeouts': { title: { en: 'Substitutions, time-outs and liberos', de: 'Wechsel, Auszeiten und Libero', fr: 'Remplacements, temps morts et libéros', it: 'Sostituzioni, timeout e libero' }, durationSec: 37.6, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  sanctions: { title: { en: 'Sanctions', de: 'Sanktionen', fr: 'Sanctions', it: 'Sanzioni' }, durationSec: 57.9, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  'set-end': { title: { en: 'Set end, interval and tie-break', de: 'Satzende, Satzpause und Entscheidungssatz', fr: 'Fin de set, pause et tie-break', it: 'Fine set, intervallo e tie-break' }, durationSec: 36, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  'match-end': { title: { en: 'Match end', de: 'Spielende', fr: 'Fin du match', it: 'Fine partita' }, durationSec: 44, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  corrections: { title: { en: 'Corrections', de: 'Korrekturen', fr: 'Corrections', it: 'Correzioni' }, durationSec: 44.6, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  connections: { title: { en: 'Connecting tablets', de: 'Tablets verbinden', fr: 'Connecter les tablettes', it: 'Collegare i tablet' }, durationSec: 36.6, width: 1920, height: 672, languages: ['en', 'de', 'fr', 'it'] },
  referee: { title: { en: 'The referee tablet', de: 'Das Schiedsrichter-Tablet', fr: "La tablette de l'arbitre", it: "Il tablet dell'arbitro" }, durationSec: 37.8, width: 1920, height: 672, languages: ['en', 'de', 'fr', 'it'] },
  bench: { title: { en: 'The bench tablet', de: 'Das Bank-Tablet', fr: 'La tablette du banc', it: 'Il tablet della panchina' }, durationSec: 36.8, width: 1920, height: 672, languages: ['en', 'de', 'fr', 'it'] },
  livescore: { title: { en: 'Livescore and scoreboard screen', de: 'Livescore und Anzeigetafel', fr: "Livescore et tableau d'affichage", it: 'Livescore e tabellone' }, durationSec: 32.7, width: 1920, height: 672, languages: ['en', 'de', 'fr', 'it'] },
  handover: { title: { en: 'Continuing on another device', de: 'Auf einem anderen Gerät weiterführen', fr: 'Continuer sur un autre appareil', it: 'Continuare su un altro dispositivo' }, durationSec: 61.1, width: 1920, height: 672, languages: ['en', 'de', 'fr', 'it'] },
  'sync-offline': { title: { en: 'Online, offline and sync', de: 'Online, offline und Synchronisierung', fr: 'En ligne, hors ligne et synchronisation', it: 'Online, offline e sincronizzazione' }, durationSec: 39.5, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] },
  'install-updates': { title: { en: 'Installing and updating', de: 'Installieren und aktualisieren', fr: 'Installer et mettre à jour', it: 'Installare e aggiornare' }, durationSec: 31.1, width: 1280, height: 872, languages: ['en', 'de', 'fr', 'it'] }
}
