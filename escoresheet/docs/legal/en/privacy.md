# Privacy policy

**OpenVolley and OpenBeach** · Version 1.0 · As of 7 October 2026

This policy is available in German, English, French and Italian. The German
version is binding.

## In short

- OpenVolley is a private, non-commercial open-source project. There are no
  ads, no tracking, no analytics tools and no cookies.
- The apps work offline. Your matches are stored on your device, and in the
  server's database only once you sign in. So that tablets receive a running
  match, the browser and Android apps send it through my server even without
  signing in, held in memory only.
- An electronic scoresheet contains data about players, team staff and
  officials: names, shirt numbers, dates of birth and signatures. Only team
  names, the score and shirt numbers are public, for beach volleyball also the
  players' names, as well as the referees' names for official matches.
  **Dates of birth, licence numbers and signatures are never public.**
- The server is in Germany (Hetzner). Cloudflare (USA) delivers the websites
  and forwards the traffic to the server.
- You can ask for access, correction or deletion at any time:
  **support@openvolley.app**.

## 1. Who is responsible

The controller is:

**Luca Canepa**, private person, Switzerland\
Postal address: see the [legal notice](impressum.md)\
Email: support@openvolley.app

I run OpenVolley as a private person. I have not appointed a data protection
officer; I am not required to. For all privacy questions, write to
support@openvolley.app.

This policy covers:

- the website **openvolley.app** and the download page **get.openvolley.app**;
- the scorer apps **OpenVolley** (indoor) and **OpenBeach** (beach) in the
  browser, as a desktop app (Windows, Linux) and as an Android app;
- the referee and bench tablet views, livescore, the roster and scoresheet
  pages and the manager sites under `*.openvolley.app`;
- the server `backend.openvolley.app` that the apps sync with.

## 2. Which law applies

I process personal data under the Swiss Federal Act on Data Protection (FADP,
in force since 1 September 2023). Where people in the EU or EEA are concerned,
for example foreign players at a beach tournament, I also follow the EU
General Data Protection Regulation (GDPR). This policy contains the
information both laws require.

## 3. Principles

- **No cookies.** The apps set no cookies. They store only what they need to
  work in your browser's or device's storage (localStorage and IndexedDB):
  match data for offline use, your settings and, when you are signed in, a
  sign-in token.
- **No tracking, no ads, no analytics.** There are no analytics tools, no
  error reports to third parties, no advertising, no profiling and no
  automated individual decisions. I do not sell data.
- **No third-party content.** Fonts and program code come from our own sites,
  not from other servers. I name the exceptions explicitly (section 12).
- **Offline first.** What you record without signing in is stored only on
  your device. For the transfer to the tablets, see section 9.

## 4. Website and download page

**openvolley.app** and **get.openvolley.app** are static pages without forms
and without third-party scripts. When you open them, Cloudflare processes the
technically necessary data: IP address, requested address, time and browser
identifier. My server keeps no access log for get.openvolley.app.

Links to GitHub and F-Droid lead to services that are themselves responsible
for their data processing.

## 5. The scorer apps (browser, desktop, Android)

**Without signing in**, the app stores everything only on your device:
matches, teams, rosters with dates of birth, sets, match events, lists of
officials, settings and a local log of how the app was used (for
troubleshooting; you can download it yourself). Matches stay stored until you
delete them or clear the app data.

**Live transfer, also without signing in.** As soon as a match is created,
the browser and Android apps send it (teams, rosters, score, events) to my
server's live relay, so that referee and bench tablets receive it (section 9).
It is held there in memory only. The desktop app uses its own relay on the
local network instead.

**When signed in**, the app syncs your matches with the server (section 7).
It also uploads:

- **Backup copies** of a match (complete, with rosters, dates of birth and
  signatures). Only your account can read them. They are deleted after
  30 days.
- **App logs** (technical messages from the app; they can contain names and
  game numbers). Only your account can read them. They are kept until you
  delete your account.
- **Scoresheets** as files (PDF and data), see section 7.

**Activity log.** For the integrity of the scoresheet and for
troubleshooting, the app keeps an activity log of each match: points and
other events, undo and corrections (what was changed, when and why), sets,
signatures and approvals (only that they happened, never the signature image
or a PIN), remarks (only their length), upload results and app errors. Each
entry carries a random identifier of the device (created by the app, not
linked to the hardware), the app version, the platform and, when signed in,
your account. It contains no more personal data than the scoresheet itself
(player numbers, officials' names in a correction). When you are signed in it
is uploaded to my server, where the scorers of the match and administrators
can read it. When an undone point had already been uploaded, the server keeps
it marked as undone instead of deleting it, so the course of the match stays
traceable. The desktop and Android apps also write the activity log as daily
files next to the backup files (`OpenVolley/logs`, at most 30 days and
50 MB). **What you click or type stays on your device:** that local log is
never uploaded, and it never records passwords or PINs. On the device the
activity log is kept up to 180 days, the click log 30 days. On the server:
24 months for entries of a match (or until the match is deleted), 90 days for
entries without a match. I delete it earlier on request (section 19).

**Desktop app.** The desktop app also keeps automatic backup files of matches
in your user folder (Linux: `~/.local/share/OpenVolley/backups`, Windows:
`%APPDATA%\OpenVolley\backups`). They contain names and dates of birth, but no
PINs, and are deleted after 30 days.

**Android app.** The Android app puts its backup files in the public
"Documents" folder. **These files remain after the app is uninstalled, and on
Android 10 and older other apps can read them too.** Delete them yourself if
needed. If you have turned on Google device backup, Android may also back up
the app data (with rosters) to your Google account; Google's terms apply to
that.

On a shared device, sign out after the match. Signing out deletes your
sign-in token and the cached teams from the app.

## 6. Account and emails

You need an account to sync matches, manage teams and tournaments, or approve
match results as an official. Accounts are opened on
`manager.openvolley.app` and `manager-beach.openvolley.app`.

**Data:** email address, password (stored only as a hash, never in plain
text), first and last name, country, date of birth (optional), roles (for
example scorer, referee, competition manager), the apps the account is for
(indoor, beach), times of creation, last sign-in and email confirmation. What
you enter at sign-up is also kept as a copy with the account.

**Purpose:** signing in, unlocking the features of your role, and pre-filling
your own details on the scoresheet (name, country, date of birth).

**New accounts** start without a role. An administrator approves them, or you
redeem an invite code. The system records who redeemed which code and when.

**Sign-in:** after you sign in, your browser stores a sign-in token. The
server holds only a hash of it. A session lasts 30 days from last use, at most
90 days, and ends when you sign out, change your password or delete the
account. To protect against attacks, the server counts failed attempts per IP
address and per email address, in memory only.

**Emails:** I only send emails that belong to the account: confirming your
email address, a link to reset your password, a notice that your password
changed, a notice that a result was approved with your approval PIN, and a
notice that your PIN was locked. They contain no tracking pixels and no
remote images. A confirmation link is valid for 24 hours, a reset link for
60 minutes.

**Who sees your account data:** you and the OpenVolley administrators (me and
people I appoint).

**Deleting your account:** you can delete your account yourself in the app at
any time. This deletes the account, profile, sessions, approval PIN, redeemed
invite codes and your uploaded backup copies and app logs. **What remains** are
official records that others have an interest in: scoresheets you recorded,
approvals you gave (with your name as it appears on the scoresheet), saved
teams and tournaments, and entries in the change log (section 14). Your
account is unlinked from these entries. You can have what remains deleted
under section 19, as far as the scoresheet does not need it.

## 7. Match data and scoresheets

**What a match contains:** game number, league, hall and town, teams (name,
short name, colour), rosters with shirt number, first and last name, date of
birth and libero or captain flag, team staff (role, name, date of birth),
officials (referees, scorer, line judges with name, country, date of birth),
**signatures** (as images drawn on the device), coin toss, the course of the
match with all events, substitutions and sanctions, results and later
corrections.

**Who enters the data:** the scorer in the app, team managers on the roster
page (`roster.openvolley.app`), competition managers through saved teams
(section 10), and the official match assignments from Swiss Volley
(section 11). Players do not enter their data themselves.

**Purpose:** an electronic scoresheet for official matches: recording during
the match, the official match record, checking eligibility and age category,
livescore.

**Who sees what:**

| Who | What |
|---|---|
| The account that recorded the match; accounts that entered the game PIN; administrators | Everything |
| Referee and bench tablets with a PIN | Teams, rosters with names and numbers, score. **No** dates of birth, signatures, officials or approvals |
| Everyone (public) | See section 8 |

Once a match is approved and closed, nobody can change it any more, not even
the person who recorded it. Only an administrator can reopen it.

**Scoresheet files:** at the end of a match the app uploads the scoresheet as
a PDF and as a file with the match data. Only the account that uploaded it can
read it (through `scoresheet.openvolley.app`), plus the administrators. If that
account is deleted, the file stays stored as the match record but nobody can
open it until an administrator grants access again.

**Approval with a PIN:** officials can confirm the result with a personal
approval PIN in addition to their signature. Stored are: the PIN as a
cryptographic hash (never in plain text), failed attempts and locks; for each
approval the match, the role (1st or 2nd referee, scorer), your account, your
name at the time of approval, the time, the approved result, and a
pseudonymised hash of the IP address and of the device (to detect misuse).
Approvals are part of the match record. You see your own approvals; the
match's scorer and the administrators see them too.

**Sending match info by email:** when you send the match info to an email
address in the app, the game number, game PIN, teams, date and venue go to
the address you enter. The recipient address is recorded in the server log.
The service Resend (USA) may be used for sending (section 15).

## 8. Public displays: livescore, LED boards, public data

Without an account and without a PIN, the following is visible:

- **Livescore** (`livescore.openvolley.app`, `livescore-beach.openvolley.app`)
  and live connections: team names, short names and colours, score, sets,
  serve, line-up, substitutions and sanctions **by shirt number only**,
  time-outs, league, hall, game number. **In beach volleyball the team names
  are usually the players' surnames, so these are public.**
- **LED boards** in the hall: team names and score.
- **Match assignments** (section 11): match data with the names of referees
  and line judges, without dates of birth.
- **Referee directory** (section 11): first and last name, country, without
  dates of birth.
- **Public beach tournaments** (section 10): teams, players' first and last
  names and countries, seeding, rank, schedule, courts.

This data can also be retrieved through the server's programming interface
(`backend.openvolley.app`).

**Never public:** dates of birth, licence numbers, signatures, approvals,
email addresses and PINs. Rosters with names are only visible to whoever
knows the match's PIN.

## 9. Tablets and venue mode (LAN)

**Referee and bench tablets** (`referee.`, `bench.`,
`referee-beach.openvolley.app`) connect to the match with a PIN. They receive
teams, rosters with names and numbers and the score, but no dates of birth,
signatures or details of officials. The referee tablet stores the PIN and the
match number in the browser; clear the browser data if several people use
the tablet.

**Through the server (cloud relay):** the live data passes through my server.
It holds it in memory only and discards it 24 hours after the last activity.
This also applies without signing in.

**Venue mode (LAN):** the desktop app can serve the tablets directly on the
hall's local network, also through the laptop's own Wi-Fi hotspot. The data
then stays in the local network and in memory only. The hotspot's name and
password are generated randomly on your device at every start. Only the sync
with the server leaves the local network, and only when the scorer is signed
in.

**LED board (LedBox):** a scoreboard in the hall can show the score. It
receives only team names, the score and set results, no player data.

## 10. Manager sites: saved teams and beach tournaments

On `manager.openvolley.app` and `manager-beach.openvolley.app`, competition
managers can prepare teams and tournaments.

**Saved teams:** team name, club, players with number, first and last name,
date of birth, licence number, libero/captain and (beach) country; team staff
with role, name, date of birth and licence number. Visible to accounts with
the manager or scorer role of that sport. The scorer apps cache these teams
and delete them on sign-out.

**Beach tournaments:** title, venue, dates, teams with the players' first and
last names, licence numbers and countries, schedule, results, names of
referees and scorers. If a tournament is marked **public**, the public
tournament page shows teams, names and countries, never licence numbers or
dates of birth.

**Purpose:** re-using rosters, running tournaments, matching players by
licence number when importing.

This data is kept until a manager deletes it, even if the account that
created it is deleted.

## 11. Data about referees

**Match assignments from Swiss Volley:** every day the server copies the
official match assignments from Swiss Volley's VolleyManager, for the period
from yesterday to 14 days ahead: teams, hall and address, league, 1st and 2nd
referee with name and date of birth, line judges, call-ups. The server uses a
VolleyManager account for this. Purpose: loading official matches with the
correct officials. Names are public (section 8); dates of birth are visible
only to signed-in users.

**Referee directory:** a shared directory with first and last name, country,
date of birth and sport, so the scorer does not have to enter officials again
each time. Signed-in accounts can add entries; administrators can change and
delete them. Names and country are public; dates of birth are visible only to
signed-in users.

If you do not want to be in the directory, write to support@openvolley.app.

## 12. Downloads and updates

- **Desktop app:** 60 seconds after start, then every 6 hours, at sign-in and
  on request, it checks whether a new version exists, never during a live
  match. It asks `get.openvolley.app`, or GitHub as a fallback. Only the
  usual request is sent (IP address, program identifier).
- **Android app from F-Droid:** the app does not look for updates itself;
  your F-Droid app does that.
- **Android app installed directly:** the app asks once whether it should
  look for updates (default: no). Only if you agree does it query
  `get.openvolley.app`, about once a day. You can turn this off again in the
  settings.
- **Home page of app.openvolley.app:** if you open it in a desktop browser,
  your browser fetches the list of the newest versions from GitHub
  (`api.github.com`, USA) to offer the right download. GitHub receives your
  IP address.
- **GitHub and F-Droid:** if you download there, their privacy policies
  apply.

## 13. Support and contact

**Support form in the apps:** it sends the type and area of the report, your
description, optionally your email address, the page address and the
browser identifier to the server. Your email address and the beginning of
your message are recorded in the server log (section 14); the report may be
forwarded by email to support@openvolley.app. I use your address only to
answer you. **For requests about your data, please write directly to
support@openvolley.app.**

**Email to support@openvolley.app:** I keep your message as long as your
request needs it.

## 14. Logs and security on the server

- **Server logs:** the server logs requests without content and **without IP
  addresses** (status, error code, request identifier). Exceptions: reports
  from the support form and the recipient address of the match info
  (sections 7 and 13). Slow database queries may be logged with their values.
  The logs are overwritten by size, usually after days to a few weeks.
- **Cloudflare** processes the IP address, address and browser identifier of
  every request and keeps them under its own rules.
- **IP addresses in memory only:** to protect against misuse the server
  limits requests and connections per IP address, and the live relay uses it
  to recognise devices at the same venue. It keeps IP addresses in memory
  only and neither stores nor logs them (except as a pseudonymised hash of an
  approval, section 7).
- **Change log:** for accountability the server records who changed roles,
  approved, closed or reopened matches, added co-editors or changed
  tournament entries, and when. The entries can contain co-editors' email
  addresses and beach team names. Only administrators see this log.

## 15. Recipients and processors

I pass personal data only to service providers I need to run the service.
They process the data on my behalf.

| Provider | Task | Country |
|---|---|---|
| Hetzner Online GmbH | Server, database, file storage | Germany |
| Cloudflare, Inc. | Delivering the websites, DNS, secure connection to the server | USA (global network) |
| Migadu | Sending email (noreply@) and mailbox (support@) | Switzerland / Europe |
| Resend, Inc. | Sending the match info by email (this function only, if enabled) | USA |

**Important about Cloudflare:** the encrypted connection from your device ends
at Cloudflare; from there it continues encrypted to my server. Cloudflare can
therefore technically see the content of requests, including rosters and
dates of birth. Cloudflare may use the data only to provide its service.

**Independently responsible** are: GitHub, Inc. (USA) for downloads and the
version list, F-Droid for the app catalogue, Swiss Volley for the data in
VolleyManager.

**Backups** are kept encrypted on my server in Germany and on my own devices
in Switzerland; no third party receives data for this (section 18).

**Transfers abroad:** according to the Swiss Federal Council, Germany and the
EU provide adequate data protection. For the USA I rely on the Swiss-U.S. Data
Privacy Framework where the provider is certified, and otherwise on the
standard contractual clauses in the providers' contracts. You can ask me for a
copy of these safeguards.

## 16. How long I keep data

| Data | Kept |
|---|---|
| Account and profile | Until you delete the account |
| Session | 30 days from last use, at most 90 days |
| Links in emails | Valid 60 minutes or 24 hours, deleted 7 days later |
| Approval PIN | Until you remove it or delete your account |
| Scoresheets, match events, signatures, approvals, scoresheet files | As the official match record, as long as needed (current season and archive). Deleted on request where the record does not need the data (section 19) |
| Saved teams, beach tournaments | Until a manager deletes them, or on request |
| Referee directory, match assignments | As long as needed; deleted on request |
| Change log | As long as needed for accountability; deletion on request is considered |
| Uploaded backup copies | 30 days |
| Uploaded app logs | Until you delete your account |
| Activity log of a match (server) | 24 months, or until the match is deleted; earlier on request |
| Activity log without a match (server) | 90 days |
| Undone and corrected events of a match | With the match, as part of the match record |
| Server logs | Overwritten by size (days to a few weeks) |
| Live data (server and venue mode) | In memory only; on the server discarded 24 hours after the last activity |
| Backups | Up to about 6 months (section 18) |
| Data on your device | Until you delete it; backup files of the desktop and Android app 30 days |

## 17. Minors

Many players are minors. Their data (name, number, date of birth) is not
entered by them but by clubs, team managers, scorers or organisers. These are
responsible for being allowed to record the data and for informing the
players and their parents. The date of birth is used to check eligibility and
age category on the official scoresheet and is never public.

Parents or other legal representatives can exercise the rights in section 19
for their child.

## 18. Security and backups

- Encrypted connections (HTTPS) for all sites and the server.
- Passwords, PINs and sign-in tokens are stored on the server only as hashes.
- Access by role; tablets only with a PIN; closed matches are read-only.
- Limits on sign-in attempts and locking after failed attempts.
- Backups: the server backs up the database every hour and the files every
  day, **encrypted**. The key to decrypt them is not on the server. The
  backups are copied daily to my own storage device in Switzerland and kept
  there for up to 90 days, and in monthly snapshots **for up to about
  6 months**. Deleted data can therefore remain in these encrypted backups for
  up to about 6 months; they are used only to restore the service.
- Backup files of the desktop app can only be read by your user account and
  contain no PINs.

No system is perfectly secure. If you find a security issue, please report it
to support@openvolley.app.

## 19. Your rights

You have the right to:

- **access**: learn which data I process about you;
- **correction** of inaccurate data;
- **deletion** or anonymisation of data;
- **object** to the processing;
- **restrict** the processing, for example while a correction is checked;
- **receive** your data in a common format or have it transferred (the apps
  also let you download backup copies and scoresheets);
- **withdraw consent** at any time (for example for the update check on
  Android).

Write to **support@openvolley.app**. I answer within 30 days. So that I do
not give data to the wrong person, I may ask for proof of your identity.

**Deletion from official scoresheets:** a closed scoresheet is the official
record of a match, in which clubs, the association and officials have an
interest. I delete or anonymise your data in it as far as the record does not
need it, and I explain what remains and why.

**Complaints:** you can complain to the Swiss Federal Data Protection and
Information Commissioner (FDPIC, www.edoeb.admin.ch). If you live in the EU
or EEA, you can also complain to the data protection authority of your
country.

## 20. Legal bases (GDPR)

Where the GDPR applies, I rely on:

- **Contract** (Art. 6(1)(b) GDPR): account, sync, account emails, support,
  the features you use.
- **Legitimate interests** (Art. 6(1)(f) GDPR): correct and verifiable
  official match records for clubs, the association and officials (rosters,
  dates of birth to check eligibility, signatures, approvals), livescore for
  the public, running tournaments, security and protection against misuse,
  backups.
- **Consent** (Art. 6(1)(a) GDPR): the optional date of birth in the account,
  the update check of the directly installed Android app.

Under the Swiss FADP I process data only for the purposes stated and to the
extent needed.

**No obligation to provide data:** you are not required by law or contract
to give me any data. Without an email address and a password I cannot open an
account, though, and without rosters there is no scoresheet.

## 21. Changes

I update this policy when the apps or the law change. The version published
on this page, with the date at the top, applies.
