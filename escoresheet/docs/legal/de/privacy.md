# Datenschutzerklärung

**OpenVolley und OpenBeach** · Version 1.0 · Stand: 7. Oktober 2026

Diese Erklärung gibt es auf Deutsch, Englisch, Französisch und Italienisch.
Massgebend ist die deutsche Fassung.

## Kurz zusammengefasst

- OpenVolley ist ein privates, nicht kommerzielles Open-Source-Projekt. Es
  gibt keine Werbung, kein Tracking, keine Analyse-Werkzeuge und keine Cookies.
- Die Apps funktionieren offline. Ihre Daten bleiben auf Ihrem Gerät, bis Sie
  sich anmelden und mit dem Server synchronisieren.
- Ein elektronischer Spielbericht enthält Daten von Spielerinnen und Spielern,
  Betreuungspersonen und Offiziellen: Namen, Rückennummern, Geburtsdaten und
  Unterschriften. Öffentlich sind nur Teamnamen, Spielstand und Rückennummern,
  bei Beachvolleyball auch die Namen der Spielerinnen und Spieler, sowie die
  Namen der Schiedsrichterinnen und Schiedsrichter offizieller Spiele.
  **Geburtsdaten, Lizenznummern und Unterschriften sind nie öffentlich.**
- Der Server steht in Deutschland (Hetzner). Cloudflare (USA) liefert die
  Websites aus und leitet den Verkehr zum Server weiter.
- Sie können jederzeit Auskunft, Berichtigung oder Löschung verlangen:
  **support@openvolley.app**.

## 1. Wer verantwortlich ist

Verantwortlich für die Datenbearbeitung ist:

**Luca Canepa**, Privatperson, Schweiz\
Postadresse: siehe [Impressum](impressum.md)\
E-Mail: support@openvolley.app

Ich betreibe OpenVolley als Privatperson. Ich habe keine Datenschutzberaterin
und keinen Datenschutzberater ernannt; dazu bin ich nicht verpflichtet. Für
alle Fragen zum Datenschutz schreiben Sie an support@openvolley.app.

Diese Erklärung gilt für:

- die Website **openvolley.app** und die Download-Seite **get.openvolley.app**;
- die Scorer-Apps **OpenVolley** (Halle) und **OpenBeach** (Beach) im Browser,
  als Desktop-App (Windows, Linux) und als Android-App;
- die Tablet-Ansichten für Schiedsrichter und Teambank, Livescore, die
  Kaderlisten- und Spielbericht-Seiten und die Manager-Seiten unter
  `*.openvolley.app`;
- den Server `backend.openvolley.app`, über den die Apps synchronisieren.

## 2. Welches Recht gilt

Ich bearbeite Personendaten nach dem Schweizer Datenschutzgesetz (DSG, in
Kraft seit 1. September 2023). Soweit Personen in der EU oder im EWR
betroffen sind, zum Beispiel ausländische Spielerinnen und Spieler an einem
Beachturnier, beachte ich zusätzlich die Datenschutz-Grundverordnung der EU
(DSGVO). Diese Erklärung enthält die Angaben, die beide Gesetze verlangen.

## 3. Grundsätze

- **Keine Cookies.** Die Apps setzen keine Cookies. Sie speichern nur das,
  was sie zum Funktionieren brauchen, im Speicher Ihres Browsers oder Geräts
  (localStorage und IndexedDB): Spieldaten für den Offline-Betrieb, Ihre
  Einstellungen und, wenn Sie angemeldet sind, ein Anmelde-Token.
- **Kein Tracking, keine Werbung, keine Analyse.** Es gibt keine
  Analyse-Werkzeuge, keine Fehlerberichte an Drittanbieter, keine
  Werbung, kein Profiling und keine automatisierten Einzelentscheidungen.
  Ich verkaufe keine Daten.
- **Keine fremden Inhalte.** Schriften und Programmcode kommen von den eigenen
  Seiten, nicht von fremden Servern. Ausnahmen nenne ich ausdrücklich
  (Abschnitt 12).
- **Offline zuerst.** Was Sie ohne Anmeldung erfassen, bleibt auf Ihrem Gerät.

## 4. Website und Download-Seite

**openvolley.app** und **get.openvolley.app** sind statische Seiten ohne
Formulare und ohne Skripte von Dritten. Beim Aufruf verarbeitet Cloudflare
technisch nötige Daten: IP-Adresse, aufgerufene Adresse, Zeitpunkt und
Browser-Kennung. Mein Server führt für get.openvolley.app kein Zugriffsprotokoll.

Links zu GitHub und F-Droid führen zu Angeboten, die selbst für ihre
Datenbearbeitung verantwortlich sind.

## 5. Die Scorer-Apps (Browser, Desktop, Android)

**Ohne Anmeldung** speichert die App alles nur auf Ihrem Gerät: Spiele,
Teams, Kaderlisten mit Geburtsdaten, Sätze, Spielereignisse, Listen von
Offiziellen, Einstellungen und ein lokales Protokoll der Bedienung (zur
Fehlersuche; Sie können es selbst herunterladen). Spiele bleiben gespeichert,
bis Sie sie löschen oder die App-Daten löschen.

**Mit Anmeldung** synchronisiert die App Ihre Spiele mit dem Server
(Abschnitt 7). Zusätzlich lädt sie hoch:

- **Sicherungskopien** eines Spiels (vollständig, mit Kaderlisten,
  Geburtsdaten und Unterschriften). Nur Ihr Konto kann sie lesen. Sie werden
  nach 30 Tagen gelöscht.
- **App-Protokolle** (technische Meldungen der App; sie können Namen und
  Spielnummern enthalten). Nur Ihr Konto kann sie lesen. Sie bleiben bis zur
  Löschung Ihres Kontos gespeichert.
- **Spielberichte** als Datei (PDF und Daten), siehe Abschnitt 7.

**Desktop-App.** Die Desktop-App speichert zusätzlich automatische
Sicherungsdateien der Spiele in Ihrem Benutzerordner (Linux:
`~/.local/share/OpenVolley/backups`, Windows: `%APPDATA%\OpenVolley\backups`).
Sie enthalten Namen und Geburtsdaten, aber keine PINs, und werden nach
30 Tagen gelöscht.

**Android-App.** Die Android-App legt ihre Sicherungsdateien im öffentlichen
Ordner «Dokumente» ab. **Diese Dateien bleiben nach dem Deinstallieren der App
erhalten und können auf Android 10 und älter auch von anderen Apps gelesen
werden.** Löschen Sie sie bei Bedarf selbst. Wenn Sie die Gerätesicherung von
Google aktiviert haben, kann Android auch die App-Daten (mit Kaderlisten) in
Ihr Google-Konto sichern; dafür gelten die Bedingungen von Google.

Auf einem gemeinsam genutzten Gerät sollten Sie sich nach dem Spiel abmelden.
Beim Abmelden löscht die App Ihr Anmelde-Token und die zwischengespeicherten
Teams.

## 6. Konto und E-Mails

Ein Konto brauchen Sie, um Spiele zu synchronisieren, Teams und Turniere zu
verwalten oder Spielresultate als Offizielle oder Offizieller freizugeben.
Konten werden auf `manager.openvolley.app` und `manager-beach.openvolley.app`
eröffnet.

**Daten:** E-Mail-Adresse, Passwort (nur als Hash gespeichert, nie im
Klartext), Vor- und Nachname, Land, Geburtsdatum (freiwillig), Rollen
(zum Beispiel Schreiber/in, Schiedsrichter/in, Wettbewerbsmanager/in), die
Apps, für die das Konto gilt (Halle, Beach), Zeitpunkte von Eröffnung,
letzter Anmeldung und E-Mail-Bestätigung. Ihre Angaben bei der
Registrierung werden zusätzlich als Kopie beim Konto gespeichert.

**Zweck:** Anmeldung, Freischalten der Funktionen Ihrer Rolle und Vorausfüllen
Ihrer eigenen Angaben im Spielbericht (Name, Land, Geburtsdatum).

**Neue Konten** haben zunächst keine Rolle. Eine Administratorin oder ein
Administrator schaltet sie frei, oder Sie lösen einen Einladungscode ein. Dabei
wird gespeichert, wer welchen Code wann eingelöst hat.

**Anmeldung:** Nach der Anmeldung speichert Ihr Browser ein Anmelde-Token. Auf
dem Server liegt nur ein Hash davon. Eine Sitzung gilt 30 Tage ab der letzten
Nutzung, höchstens 90 Tage, und endet beim Abmelden, beim Ändern des Passworts
und beim Löschen des Kontos. Zum Schutz vor Angriffen zählt der Server
Fehlversuche pro IP-Adresse und pro E-Mail-Adresse, nur im Arbeitsspeicher.

**E-Mails:** Ich sende nur E-Mails, die zum Konto gehören: Bestätigung der
E-Mail-Adresse, Link zum Zurücksetzen des Passworts, Hinweis auf eine
Passwortänderung, Hinweis, dass ein Resultat mit Ihrem Freigabe-PIN
freigegeben wurde, und Hinweis, dass Ihr PIN gesperrt wurde. Sie enthalten
keine Zählpixel und keine nachgeladenen Bilder. Ein Bestätigungslink gilt
24 Stunden, ein Link zum Zurücksetzen 60 Minuten.

**Wer sieht Ihre Kontodaten:** Sie selbst und die Administratorinnen und
Administratoren von OpenVolley (ich und von mir bestimmte Personen).

**Konto löschen:** Sie können Ihr Konto jederzeit selbst in der App löschen.
Dabei werden Konto, Profil, Sitzungen, Freigabe-PIN, eingelöste
Einladungscodes und Ihre hochgeladenen Sicherungskopien und App-Protokolle
gelöscht. **Bestehen bleiben** offizielle Unterlagen, an denen andere ein
Interesse haben: Spielberichte, die Sie erfasst haben, Freigaben, die Sie
erteilt haben (mit Ihrem Namen, wie er im Spielbericht steht), gespeicherte
Teams und Turniere sowie Einträge im Änderungsprotokoll (Abschnitt 14). Ihr
Konto wird von diesen Einträgen getrennt. Was bestehen bleibt, können Sie
nach Abschnitt 19 löschen lassen, soweit es für den Spielbericht nicht nötig ist.

## 7. Spieldaten und Spielberichte

**Inhalt eines Spiels:** Spielnummer, Liga, Halle und Ort, Teams (Name,
Kurzname, Farbe), Kaderlisten mit Rückennummer, Vor- und Nachname,
Geburtsdatum und Kennzeichnung als Libero oder Captain, Betreuungspersonen
(Funktion, Name, Geburtsdatum), Offizielle (Schiedsrichter, Schreiber,
Linienrichter mit Name, Land, Geburtsdatum), **Unterschriften** (als Bild,
auf dem Gerät gezeichnet), Platzwahl, Spielverlauf mit allen Ereignissen,
Wechseln und Sanktionen, Resultate und nachträgliche Korrekturen.

**Wer die Daten eingibt:** die Schreiberin oder der Schreiber in der App,
Teamverantwortliche über die Kaderlisten-Seite (`roster.openvolley.app`),
Wettbewerbsmanagerinnen und -manager über gespeicherte Teams (Abschnitt 10),
und die offiziellen Ansetzungen von Swiss Volley (Abschnitt 11).
Spielerinnen und Spieler geben ihre Daten nicht selbst ein.

**Zweck:** ein elektronischer Spielbericht für offizielle Spiele: Erfassung
während des Spiels, die offizielle Spielaufzeichnung, Kontrolle der
Spielberechtigung und Alterskategorie, Livescore.

**Wer was sieht:**

| Wer | Was |
|---|---|
| Das Konto, das das Spiel erfasst hat; Konten, die den Spiel-PIN eingegeben haben; Administratorinnen und Administratoren | Alles |
| Schiedsrichter- und Bank-Tablets mit PIN | Teams, Kaderlisten mit Namen und Nummern, Spielstand. **Keine** Geburtsdaten, Unterschriften, Offiziellen oder Freigaben |
| Alle (öffentlich) | Siehe Abschnitt 8 |

Ist ein Spiel freigegeben und abgeschlossen, kann es niemand mehr ändern,
auch nicht die Person, die es erfasst hat. Nur eine Administratorin oder ein
Administrator kann es wieder öffnen.

**Spielbericht-Dateien:** Am Ende eines Spiels lädt die App den Spielbericht
als PDF und als Datei mit den Spieldaten hoch. Lesen kann ihn nur das Konto,
das ihn hochgeladen hat (über `scoresheet.openvolley.app`), sowie die
Administration. Wird dieses Konto gelöscht, bleibt die Datei als
Spielaufzeichnung gespeichert, ist aber für niemanden mehr abrufbar, bis eine
Administratorin oder ein Administrator den Zugriff wieder vergibt.

**Freigabe mit PIN:** Offizielle können das Resultat zusätzlich zur
Unterschrift mit einem persönlichen Freigabe-PIN bestätigen. Gespeichert
werden: der PIN als kryptografischer Hash (nie im Klartext), Fehlversuche und
Sperren; pro Freigabe das Spiel, die Funktion (1. oder 2. Schiedsrichter,
Schreiber), Ihr Konto, Ihr Name zum Zeitpunkt der Freigabe, Zeitpunkt, das
freigegebene Resultat sowie ein pseudonymisierter Hash der IP-Adresse und des
Geräts (um Missbrauch zu erkennen). Freigaben sind Teil der Spielaufzeichnung.
Sie sehen Ihre eigenen Freigaben; die Schreiberin oder der Schreiber des
Spiels und die Administration sehen sie auch.

**Spielinfo per E-Mail:** Wenn Sie in der App die Spielinfo an eine
E-Mail-Adresse senden, gehen Spielnummer, Spiel-PIN, Teams, Datum und Ort an
die Adresse, die Sie eingeben. Die Empfängeradresse wird im Serverprotokoll
festgehalten. Für den Versand kann der Dienst Resend (USA) eingesetzt werden
(Abschnitt 15).

## 8. Öffentliche Anzeigen: Livescore, LED-Anzeige, öffentliche Daten

Ohne Anmeldung und ohne PIN sind sichtbar:

- **Livescore** (`livescore.openvolley.app`, `livescore-beach.openvolley.app`)
  und Live-Verbindungen: Teamnamen, Kurznamen und Farben, Spielstand, Sätze,
  Aufschlag, Aufstellung, Wechsel und Sanktionen **nur mit Rückennummern**,
  Auszeiten, Liga, Halle, Spielnummer. **Bei Beachvolleyball bestehen die
  Teamnamen meist aus den Nachnamen der Spielerinnen und Spieler; diese sind
  damit öffentlich.**
- **LED-Anzeigen** in der Halle: Teamnamen und Spielstand.
- **Spielansetzungen** (Abschnitt 11): Spieldaten mit den Namen der
  Schiedsrichter und Linienrichter, ohne Geburtsdaten.
- **Schiedsrichter-Verzeichnis** (Abschnitt 11): Vor- und Nachname, Land,
  ohne Geburtsdaten.
- **Öffentliche Beachturniere** (Abschnitt 10): Teams, Vor- und Nachnamen und
  Länder der Spielerinnen und Spieler, Setzung, Rang, Spielplan, Felder.

Diese Daten sind auch über die Programmierschnittstelle des Servers
(`backend.openvolley.app`) abrufbar.

**Nie öffentlich:** Geburtsdaten, Lizenznummern, Unterschriften, Freigaben,
E-Mail-Adressen und PINs. Kaderlisten mit Namen sieht nur, wer den PIN des
Spiels kennt.

## 9. Tablets und Hallen-Modus (LAN)

**Tablets für Schiedsrichter und Teambank** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) verbinden sich mit einem PIN mit dem Spiel.
Sie erhalten Teams, Kaderlisten mit Namen und Nummern und den Spielstand, aber
keine Geburtsdaten, Unterschriften oder Angaben zu Offiziellen. Das
Schiedsrichter-Tablet speichert den PIN und die Spielnummer im Browser;
löschen Sie die Browserdaten, wenn das Tablet von mehreren Personen benutzt
wird.

**Über den Server (Cloud-Relay):** Die Live-Daten laufen über meinen Server.
Er hält sie nur im Arbeitsspeicher und verwirft sie 24 Stunden nach der
letzten Aktivität.

**Hallen-Modus (LAN):** Die Desktop-App kann die Tablets direkt im lokalen
Netz der Halle bedienen, auch über einen eigenen WLAN-Hotspot des Laptops.
Die Daten bleiben dann im lokalen Netz und nur im Arbeitsspeicher. Name und
Passwort des Hotspots werden bei jedem Start zufällig auf Ihrem Gerät erzeugt.
Nur die Synchronisierung mit dem Server verlässt das lokale Netz, und nur,
wenn die Schreiberin oder der Schreiber angemeldet ist.

**LED-Anzeige (LedBox):** Eine Anzeigetafel in der Halle kann den Spielstand
übernehmen. Sie erhält nur Teamnamen, Spielstand und Satzresultate, keine
Daten von Spielerinnen und Spielern.

## 10. Manager-Seiten: gespeicherte Teams und Beachturniere

Auf `manager.openvolley.app` und `manager-beach.openvolley.app` können
Wettbewerbsmanagerinnen und -manager Teams und Turniere vorbereiten.

**Gespeicherte Teams:** Teamname, Verein, Spielerinnen und Spieler mit Nummer,
Vor- und Nachname, Geburtsdatum, Lizenznummer, Libero/Captain und (Beach)
Land; Betreuungspersonen mit Funktion, Name, Geburtsdatum und Lizenznummer.
Sichtbar für Konten mit Manager- oder Schreiberrolle der jeweiligen Sportart.
Die Scorer-Apps speichern diese Teams zwischen und löschen sie beim Abmelden.

**Beachturniere:** Titel, Ort, Daten, Teams mit Vor- und Nachname,
Lizenznummer und Land der Spielerinnen und Spieler, Spielplan, Resultate,
Namen der Schiedsrichter und Schreiber. Ist ein Turnier als **öffentlich**
markiert, zeigt die öffentliche Turnierseite Teams, Namen und Länder, nie
Lizenznummern oder Geburtsdaten.

**Zweck:** Kaderlisten wiederverwenden, Turniere organisieren, Spielerinnen
und Spieler beim Import anhand der Lizenznummer zuordnen.

Diese Daten bleiben gespeichert, bis eine Managerin oder ein Manager sie
löscht, auch wenn das Konto, das sie angelegt hat, gelöscht wird.

## 11. Daten von Schiedsrichterinnen und Schiedsrichtern

**Spielansetzungen von Swiss Volley:** Der Server übernimmt täglich die
offiziellen Spielansetzungen aus dem VolleyManager von Swiss Volley, für den
Zeitraum von gestern bis 14 Tage voraus: Teams, Halle und Adresse, Liga, 1.
und 2. Schiedsrichter mit Name und Geburtsdatum, Linienrichter, Aufgebote.
Dafür verwendet der Server ein Konto im VolleyManager. Zweck: offizielle
Spiele mit den richtigen Offiziellen laden. Namen sind öffentlich (Abschnitt
8), Geburtsdaten sieht nur, wer angemeldet ist.

**Schiedsrichter-Verzeichnis:** Ein gemeinsames Verzeichnis mit Vor- und
Nachname, Land, Geburtsdatum und Sportart, damit die Schreiberin oder der
Schreiber Offizielle nicht jedes Mal neu erfassen muss. Angemeldete Konten
können Einträge hinzufügen; ändern und löschen kann die Administration. Namen
und Land sind öffentlich, Geburtsdaten sieht nur, wer angemeldet ist.

Wenn Sie nicht im Verzeichnis stehen möchten, schreiben Sie an
support@openvolley.app.

## 12. Downloads und Updates

- **Desktop-App:** Sie prüft 60 Sekunden nach dem Start, danach alle
  6 Stunden, bei der Anmeldung und auf Wunsch, ob es eine neue Version gibt,
  nie während eines laufenden Spiels. Sie fragt dazu
  `get.openvolley.app` ab, ersatzweise GitHub. Dabei wird nur die übliche
  Anfrage übermittelt (IP-Adresse, Programmkennung).
- **Android-App aus F-Droid:** Die App sucht nicht selbst nach Updates; das
  macht Ihre F-Droid-App.
- **Android-App direkt installiert:** Die App fragt einmal, ob sie nach
  Updates suchen soll (voreingestellt: nein). Nur wenn Sie zustimmen, ruft sie
  höchstens einmal täglich `get.openvolley.app` ab. Sie können das in den
  Einstellungen wieder abschalten.
- **Startseite von app.openvolley.app:** Öffnen Sie sie im Browser eines
  Desktop-Systems, ruft Ihr Browser bei GitHub (`api.github.com`, USA) die
  Liste der neuesten Versionen ab, um den passenden Download anzubieten. Dabei
  erhält GitHub Ihre IP-Adresse.
- **GitHub und F-Droid:** Wenn Sie dort herunterladen, gelten deren
  Datenschutzbestimmungen.

## 13. Support und Kontakt

**Support-Formular in den Apps:** Es übermittelt Art und Bereich der Meldung,
Ihre Beschreibung, freiwillig Ihre E-Mail-Adresse, die Adresse der Seite und
die Browser-Kennung an den Server. Ihre E-Mail-Adresse und der Anfang Ihrer
Nachricht werden im Serverprotokoll festgehalten (Abschnitt 14); die Meldung
kann per E-Mail an support@openvolley.app weitergeleitet werden. Ich verwende
Ihre Adresse nur, um Ihnen zu antworten. **Für Anfragen zu Ihren Daten
schreiben Sie bitte direkt an support@openvolley.app.**

**E-Mail an support@openvolley.app:** Ich bewahre Ihre Nachricht so lange auf,
wie es für Ihr Anliegen nötig ist.

## 14. Protokolle und Sicherheit auf dem Server

- **Serverprotokolle:** Der Server protokolliert Anfragen ohne Inhalte und
  **ohne IP-Adressen** (Status, Fehlercode, Kennung der Anfrage). Ausnahmen:
  Meldungen aus dem Support-Formular und die Empfängeradresse der Spielinfo
  (Abschnitte 7 und 13). Langsame Datenbankabfragen können mit ihren Werten
  protokolliert werden. Die Protokolle werden nach Grösse überschrieben, in der
  Regel nach Tagen bis wenigen Wochen.
- **Cloudflare** verarbeitet bei jeder Anfrage IP-Adresse, Adresse und
  Browser-Kennung und bewahrt sie nach seinen eigenen Regeln auf.
- **Änderungsprotokoll:** Für die Nachvollziehbarkeit hält der Server fest,
  wer wann Rollen geändert, Spiele freigegeben, abgeschlossen oder wieder
  geöffnet, Mitbearbeitende hinzugefügt oder Turniereinträge geändert hat.
  Die Einträge können E-Mail-Adressen von Mitbearbeitenden und Namen von
  Beach-Teams enthalten. Nur die Administration sieht dieses Protokoll.

## 15. Empfänger und Auftragsbearbeiter

Ich gebe Personendaten nur an Dienstleister weiter, die ich für den Betrieb
brauche. Sie bearbeiten die Daten in meinem Auftrag.

| Dienstleister | Aufgabe | Land |
|---|---|---|
| Hetzner Online GmbH | Server, Datenbank, Dateispeicher | Deutschland |
| Cloudflare, Inc. | Auslieferung der Websites, DNS, sichere Verbindung zum Server | USA (weltweites Netz) |
| Migadu | E-Mail-Versand (noreply@) und Postfach (support@) | Schweiz / Europa |
| Resend, Inc. | Versand der Spielinfo per E-Mail (nur diese Funktion, falls aktiviert) | USA |

**Wichtig zu Cloudflare:** Die verschlüsselte Verbindung Ihres Geräts endet
bei Cloudflare; von dort läuft sie verschlüsselt weiter zu meinem Server.
Cloudflare kann den Inhalt der Anfragen deshalb technisch einsehen, auch
Kaderlisten und Geburtsdaten. Cloudflare darf die Daten nur für die
Erbringung seines Dienstes verwenden.

**Eigenständig verantwortlich** sind: GitHub, Inc. (USA) für Downloads und
die Versionsliste, F-Droid für den App-Katalog, Swiss Volley für die Daten
im VolleyManager.

**Datensicherungen** liegen verschlüsselt auf meinem Server in Deutschland und
auf meinen eigenen Geräten in der Schweiz; dafür gebe ich keine Daten an
Dritte (Abschnitt 18).

**Übermittlung ins Ausland:** Deutschland und die EU bieten nach dem Schweizer
Bundesrat einen angemessenen Datenschutz. Für die USA stütze ich mich auf das
Swiss-U.S. Data Privacy Framework, soweit der Anbieter zertifiziert ist, und
sonst auf die Standardvertragsklauseln in den Verträgen der Anbieter.

## 16. Wie lange ich Daten aufbewahre

| Daten | Aufbewahrung |
|---|---|
| Konto und Profil | Bis Sie das Konto löschen |
| Sitzung | 30 Tage ab letzter Nutzung, höchstens 90 Tage |
| Links in E-Mails | 60 Minuten bzw. 24 Stunden gültig, 7 Tage danach gelöscht |
| Freigabe-PIN | Bis Sie ihn entfernen oder Ihr Konto löschen |
| Spielberichte, Spielereignisse, Unterschriften, Freigaben, Spielbericht-Dateien | Als offizielle Spielaufzeichnung, so lange wie nötig (laufende Saison und Archiv). Löschung auf Anfrage, soweit die Daten für die Aufzeichnung nicht nötig sind (Abschnitt 19) |
| Gespeicherte Teams, Beachturniere | Bis eine Managerin oder ein Manager sie löscht, oder auf Anfrage |
| Schiedsrichter-Verzeichnis, Spielansetzungen | So lange wie nötig; Löschung auf Anfrage |
| Änderungsprotokoll | So lange wie für die Nachvollziehbarkeit nötig; Löschung auf Anfrage geprüft |
| Hochgeladene Sicherungskopien | 30 Tage |
| Hochgeladene App-Protokolle | Bis Sie Ihr Konto löschen |
| Serverprotokolle | Überschrieben nach Grösse (Tage bis wenige Wochen) |
| Live-Daten (Server und Hallen-Modus) | Nur im Arbeitsspeicher; auf dem Server 24 Stunden nach der letzten Aktivität verworfen |
| Datensicherungen | Bis etwa 6 Monate (Abschnitt 18) |
| Daten auf Ihrem Gerät | Bis Sie sie löschen; Sicherungsdateien der Desktop- und Android-App 30 Tage |

## 17. Minderjährige

Viele Spielerinnen und Spieler sind minderjährig. Ihre Daten (Name, Nummer,
Geburtsdatum) geben nicht sie selbst ein, sondern Vereine, Teamverantwortliche,
Schreiberinnen und Schreiber oder Veranstalter. Diese sind dafür
verantwortlich, dass sie die Daten erfassen dürfen und die Spielerinnen und
Spieler und deren Eltern darüber informieren. Das Geburtsdatum dient der
Kontrolle der Spielberechtigung und Alterskategorie auf dem offiziellen
Spielbericht und ist nie öffentlich.

Eltern oder andere gesetzliche Vertreter können die Rechte nach Abschnitt 19
für ihr Kind ausüben.

## 18. Datensicherheit und Datensicherungen

- Verschlüsselte Verbindungen (HTTPS) für alle Seiten und den Server.
- Passwörter, PINs und Anmelde-Token liegen nur als Hash auf dem Server.
- Zugriff nach Rollen; Tablets nur mit PIN; abgeschlossene Spiele sind
  schreibgeschützt.
- Begrenzung von Anmeldeversuchen und Sperre nach Fehlversuchen.
- Datensicherungen: Der Server sichert die Datenbank stündlich und die
  Dateien täglich, **verschlüsselt**. Der Schlüssel zum Entschlüsseln liegt
  nicht auf dem Server. Die Sicherungen werden täglich auf mein eigenes
  Speichergerät in der Schweiz kopiert und dort bis 90 Tage und in
  Monats-Schnappschüssen **bis etwa 6 Monate** aufbewahrt. Gelöschte Daten
  können deshalb noch bis zu etwa 6 Monate in diesen verschlüsselten
  Sicherungen enthalten sein; sie werden nur für eine Wiederherstellung
  verwendet.
- Sicherungsdateien der Desktop-App sind nur für Ihr Benutzerkonto lesbar und
  enthalten keine PINs.

Kein System ist vollkommen sicher. Wenn Sie eine Sicherheitslücke finden,
melden Sie sie bitte an support@openvolley.app.

## 19. Ihre Rechte

Sie haben das Recht:

- **Auskunft** zu erhalten, welche Daten ich über Sie bearbeite;
- unrichtige Daten **berichtigen** zu lassen;
- Daten **löschen** oder unkenntlich machen zu lassen;
- der Bearbeitung zu **widersprechen**;
- Ihre Daten in einem gängigen Format zu **erhalten** oder übertragen zu
  lassen (die Apps bieten dafür auch den Download von Sicherungskopien und
  Spielberichten);
- eine **Einwilligung** (zum Beispiel für die Update-Prüfung auf Android)
  jederzeit zu widerrufen.

Schreiben Sie an **support@openvolley.app**. Ich antworte innert 30 Tagen.
Damit ich keine Daten an die falsche Person gebe, kann ich einen Nachweis
Ihrer Identität verlangen.

**Löschung bei offiziellen Spielberichten:** Ein abgeschlossener Spielbericht
ist die offizielle Aufzeichnung eines Spiels, an der Vereine, Verband und
Offizielle ein Interesse haben. Ich lösche oder anonymisiere Ihre Daten
darin, soweit sie für die Aufzeichnung nicht nötig sind, und erkläre Ihnen,
was aus welchem Grund bestehen bleibt.

**Beschwerde:** Sie können sich beim Eidgenössischen Datenschutz- und
Öffentlichkeitsbeauftragten (EDÖB, www.edoeb.admin.ch) beschweren. Wenn Sie
in der EU oder im EWR wohnen, auch bei der Datenschutzbehörde Ihres Landes.

## 20. Rechtsgrundlagen (DSGVO)

Soweit die DSGVO gilt, stütze ich mich auf:

- **Vertrag** (Art. 6 Abs. 1 lit. b DSGVO): Konto, Synchronisierung,
  E-Mails zum Konto, Support, die Funktionen, die Sie nutzen.
- **Berechtigtes Interesse** (Art. 6 Abs. 1 lit. f DSGVO): korrekte und
  überprüfbare offizielle Spielaufzeichnungen für Vereine, Verband und
  Offizielle (Kaderlisten, Geburtsdaten zur Kontrolle der Spielberechtigung,
  Unterschriften, Freigaben), Livescore für das Publikum, Organisation von
  Turnieren, Sicherheit und Missbrauchsschutz, Datensicherungen.
- **Einwilligung** (Art. 6 Abs. 1 lit. a DSGVO): freiwilliges Geburtsdatum im
  Konto, Update-Prüfung der direkt installierten Android-App.

Nach dem Schweizer DSG bearbeite ich Daten nur für die genannten Zwecke und
im nötigen Umfang.

## 21. Änderungen

Ich passe diese Erklärung an, wenn sich die Apps oder die Rechtslage ändern.
Es gilt die auf dieser Seite veröffentlichte Fassung mit dem Datum oben.
