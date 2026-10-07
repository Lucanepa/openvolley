# Legal texts (internal note)

Not published. The public pages are built from `{de,en,fr,it}/*.md`:

| File | Page |
|---|---|
| `privacy.md` | Datenschutzerklärung / Privacy policy |
| `impressum.md` | Impressum / Legal notice |
| `terms.md` | Nutzungsbedingungen / Terms of use |
| `opensource.md` | Open-Source-Hinweis / Open-source notice |

German is the binding version; EN/FR/IT are translations and must be kept in
step with it (same sections, same numbering). Cross-links are relative
(`privacy.md`, `impressum.md`, ...); the site build maps them to page URLs.
The facts behind the texts are in [data-map.md](data-map.md).

**Not legal advice.** Before go-live, have the texts and the data map
reviewed by a Swiss lawyer and checked against the FDPIC (EDÖB) guidance for
private operators, including the open points in data-map.md section 1
(controller of the match records, GDPR Art. 27 EU representative).

## Placeholders (fill in once per language)

- `[ADRESSE / ADDRESS]`: only in `*/impressum.md`. Privacy policy and terms
  refer to the Impressum for the address.
- `[GERICHTSSTAND / PLACE OF JURISDICTION]`: only in `*/terms.md`, section 10.

## Statements that depend on owner facts (check before go-live)

1. Hetzner location is Germany (privacy 15, "In short").
2. Migadu: "Switzerland / Europe" for the company and mail servers.
3. Resend is listed for "match info by email" because the code can use it
   (`RESEND_API_KEY`). If the key is not set, or the code is removed (F13),
   drop the row and the sentence in privacy 7.
4. Support form: privacy 13 says the report "may be forwarded" to support@,
   because with `SMTP_LEGACY_ROUTES` unset it is only logged (F12). Once the
   form delivers to support@, say so plainly.
5. Cloudflare is DPF-certified and its DPA covers Pages/Tunnel/DNS (privacy
   15); Cloudflare Web Analytics / RUM is off everywhere (privacy 3: "no
   analytics").
6. Backups: NAS in Switzerland, ~6-month snapshot horizon, lenovoserver in
   Switzerland (privacy 15, 16, 18).
7. VolleyManager: the account used by the sync is allowed to store and show
   referee data (privacy 11, F6).
8. Administrators: "me and people I appoint" (privacy 6, 7).
9. Retention of finished match records: "current season and archive" with no
   fixed end; support mails "as long as the request needs it". Set concrete
   periods if wanted (data-map Q5).
10. Minimum age 16 for accounts (terms 3) is a rule in the terms only; the
    sign-up does not check it.
11. Trademarks line in the Impressum names Swiss Volley, VolleyManager, FIVB;
    no statement is made about any affiliation with Swiss Volley. Add one if
    there is an agreement or if independence should be stated.
12. OpenBeach is GPL-3.0-or-later like OpenVolley (its `escoresheet/LICENSE`
    is GPL-3.0; confirm "or later" in its README).
13. `readvolley.openvolley.app` is a separate app with its own backend and is
    **not covered** by these texts. Either add a section or give it its own
    notice.

## Findings that limit what the texts can promise

The texts describe the code as it is (2026-10-07). When these are fixed,
update the texts:

- **F1**: referee dates of birth are visible to any signed-in account
  (privacy 11 says so). After restricting them to scorers/admins, change
  "signed-in users" to the roles.
- **F2**: closed matches can only be redacted by manual SQL. Privacy 19
  promises deletion/anonymisation "as far as the record does not need it";
  that is done by hand until an admin tool exists.
- **F4**: uploaded app logs are kept until account deletion (privacy 5, 16).
- **F9**: Android backups in the public Documents folder (privacy 5).
- **F14**: the app.openvolley.app home page calls api.github.com (privacy 12).
- **F3, F5, F10, F21**: no fixed retention for scoresheet files, change log,
  dormant accounts, orphaned saved teams (privacy 16 says "as long as
  needed").
- Licence notices: Apache-2.0 and MIT require the notices to travel with
  binaries. Consider shipping a generated third-party licence file with the
  desktop and Android builds.
