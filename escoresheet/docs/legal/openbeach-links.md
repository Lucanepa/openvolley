# OpenBeach: links to the legal pages (to do)

The legal pages cover OpenVolley **and** OpenBeach. OpenVolley links them
since `feat/legal-links`; the OpenBeach app (repo `openbeach`, frontend in
`escoresheet/frontend/src_beach/`) does not yet. This is the list of changes
it needs. Not done here, because another job was changing that repo at the
time (worktree `wt-ob-release`, read at `3ec6847`).

Shared by both repos and already done in openvolley (no OpenBeach change
needed): `manager-beach.openvolley.app` (sign-in card, sign-up page with
the terms sentence, console footer, built from the openvolley frontend),
the backend status page, the account emails (privacy line in every mail,
OpenBeach-branded ones too) and `get.openvolley.app`.

## The URLs

Same URLs as OpenVolley; German is binding. Language of the page from the
app language: `de`, `de-CH` -> German, `fr`, `it`, everything else -> English.

| Document | de | en | fr | it |
|---|---|---|---|---|
| privacy | /datenschutz | /en/privacy | /fr/confidentialite | /it/privacy |
| terms | /nutzungsbedingungen | /en/terms | /fr/conditions | /it/condizioni |
| impressum | /impressum | /en/imprint | /fr/mentions-legales | /it/note-legali |
| opensource | /open-source | /en/open-source | /fr/open-source | /it/open-source |

All under `https://openvolley.app`.

## Changes

1. **One constant.** Copy `escoresheet/frontend/src/legal/legalLinks.js` from
   openvolley to `src_beach/lib_beach/legalLinks_beach.js` (next to
   `accountLinks_beach.js`), unchanged except a header line naming the source.
   Add a test that pins the URLs above (the openvolley test
   `src/legal/__tests__/legalLinks.test.jsx` can be adapted), so a change on
   one side shows up.

2. **Component.** Port `src/legal/LegalLinks.jsx` (`LegalLinks`, `LegalLink`)
   to `src_beach/components_beach/LegalLinks_beach.jsx`, importing `cn` from
   `src_beach/ui/volleyui`. Links are plain `<a target="_blank"
   rel="noopener noreferrer">`, like `SIGNUP_URL` in `LoginModal_beach.jsx`
   (desktop: the system browser; Android: the WebView hands other hosts to
   the browser). `LegalSentence` is not needed: OpenBeach has no in-app
   sign-up (decision D4).

3. **i18n**, `src_beach/i18n_beach/locales/{en,de,de-CH,fr,it}.json`, a new
   top-level `legal` object with the same strings as openvolley (sentence
   case, Swiss `ss`):

   | key | en | de / de-CH | fr | it |
   |---|---|---|---|---|
   | `legal.nav` | Legal | Rechtliches | Informations légales | Note legali |
   | `legal.privacy` | Privacy policy | Datenschutzerklärung | Protection des données | Protezione dei dati |
   | `legal.terms` | Terms of use | Nutzungsbedingungen | Conditions d’utilisation | Condizioni d’uso |
   | `legal.impressum` | Legal notice | Impressum | Mentions légales | Note legali |
   | `legal.opensource` | Open-source notice | Open-Source-Hinweis | Avis open source | Avviso open source |

4. **Options -> App version** (`components_beach/options/HomeOptionsModal_beach.jsx`,
   the `options-app-version` section, after the "Icons" `OptionRow`): one
   more `OptionRow` (or its `below` slot) with `<LegalLinks />`, all four
   documents. This covers the browser app, the desktop app's About and the
   Android app's Options (same component). While there: the icon credit
   could add flag-icons (MIT), which the open-source notice lists for
   OpenBeach.

5. **Sign-in modal** (`components_beach/auth/LoginModal_beach.jsx`): under
   the link list at the end of the form (after the "Create account" /
   "Competitions admin" links, before `</form>`):
   `<LegalLinks docs={['privacy', 'terms', 'impressum']} className="pt-2 text-[11px] text-stone-400" />`.
   Next to "Create account" the privacy policy matters most: the account is
   made on manager-beach, where the terms sentence is shown.

6. **Referee and scoreboard tablets**: the options menu of
   `components_beach/DashboardHeader_beach.jsx` (used by
   `RefereeApp_beach.jsx`, and by `LivescoreApp_beach.jsx` with
   `showOptionsMenu={false}`): add the three links (privacy, terms,
   impressum) at the end of the menu, as `DashboardOptionsMenu.jsx` does in
   openvolley.

7. **Livescore** (`LivescoreApp_beach.jsx`, the list page; its header has no
   options menu): a footer line under the list,
   `<LegalLinks docs={['privacy', 'terms', 'impressum']} className="mt-8 text-center text-[11px] text-stone-400" />`.
   This page is public and shows the players' names, which the privacy
   policy (section 8) describes.

8. **Scoresheet archive** (`ScoresheetApp_beach.jsx`, the list page): the
   same footer line at the end of the page.

9. **Competition admin** (`CompetitionAdminApp_beach.jsx`, `admin_beach.html`,
   only when `COMPETITIONS_ENABLED`): the same footer line under its gate /
   console. The tournaments there hold names, licence numbers and countries.

10. **Scoreboard output** (`ScoreboardApp_beach.jsx`, the LED/TV view): no
    link (no reader, no personal data beyond team names).

11. **Store metadata**: `fastlane/metadata/android/*` has no privacy-policy
    field (F-Droid has none either), so nothing to change. If OpenBeach is
    ever listed on Google Play, give the privacy URL there.

12. **Tests**: as in openvolley, assert the hrefs in the Options test (all
    four, English by default), and that `LoginModal_beach` renders the three
    links. Run the full vitest suite.

## Open points for the owner

- OpenBeach's `escoresheet/LICENSE` is GPL-3.0; the legal texts say
  "GPL-3.0-or-later" for both apps. Confirm "or later" (README / source
  headers) or change the open-source notice and the impressum for OpenBeach.
- The legal texts' section 5 (scorer apps) describes OpenVolley's local
  storage and backups; check that OpenBeach's desktop/Android backups behave
  the same (folder names, 30 days), or add the differences.
