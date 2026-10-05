// supabase/functions/vm-sync/index.ts
//
// VolleyManager → Supabase sync as Edge Function
// Trigger via cron or manual invoke.
//
// Secrets needed (set via Supabase dashboard → Edge Functions → Secrets):
//   VM_USERNAME, VM_PASSWORD, SUPABASE_SERVICE_ROLE_KEY
//
// Cron setup (in supabase/config.toml or dashboard):
//   [functions.vm-sync]
//   schedule = "0 6 * * *"

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VM_BASE = "https://volleymanager.volleyball.ch";
const BATCH_SIZE = 200;

// Leagues to EXCLUDE (above 1L)
const EXCLUDED_LEAGUES = ["nl", "nationalliga", "nla", "nlb"];

function getTodayRange(): { from: string; to: string } {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // "2026-02-24"
  return {
    from: `${dateStr}T00:00:00.000Z`,
    to: `${dateStr}T23:59:59.000Z`,
  };
}

const RENDER_PROPERTIES = [
  "game.startingDateTime", "gameDayOfWeek", "game.number",
  "game.group.phase.league.leagueCategory.name",
  "game.group.phase.league.leagueCategory.displayNameWithManagingAssociationShortName",
  "game.group.phase.league.gender",
  "game.group.name", "game.group.displayName",
  "game.group.phase.name", "game.group.phase.displayName",
  "game.encounter.teamHome.identifier", "game.encounter.teamHome.name",
  "game.encounter.teamHome.displayName", "game.encounter.teamHome.leagueCategory.name",
  "game.encounter.teamAway.identifier", "game.encounter.teamAway.name",
  "game.encounter.teamAway.displayName", "game.encounter.teamAway.leagueCategory.name",
  "game.hall.name", "game.hall.displayName",
  "game.hall.primaryPostalAddress.additionToAddress",
  "game.hall.primaryPostalAddress.combinedAddress",
  "game.hall.primaryPostalAddress.country.countryCode",
  "game.hall.primaryPostalAddress.postalCode",
  "game.hall.primaryPostalAddress.city",
  "activeFirstHeadRefereeName", "activeSecondHeadRefereeName",
  "activeFirstLinesmanRefereeName", "activeSecondLinesmanRefereeName",
  "activeThirdLinesmanRefereeName", "activeFourthLinesmanRefereeName",
  "activeStandbyHeadRefereeName", "activeStandbyLinesmanName",
  "isSupervised", "isHeadOneSupervised", "isHeadTwoSupervised",
  "isLinesmanOneSupervised", "isLinesmanTwoSupervised",
  "isLinesmanThreeSupervised", "isLinesmanFourSupervised",
  "hasAtLeastOneRefereeIntendedToBeSupervised",
  "refereeConvocations.*.indoorAssociationReferee.indoorReferee.person.displayName",
];

// ---------------------------------------------------------------------------
// Cookie-aware fetch (Deno fetch doesn't handle cookies automatically)
// ---------------------------------------------------------------------------

class CookieJar {
  cookies: Record<string, string> = {};

  update(response: Response) {
    for (const header of response.headers.getSetCookie?.() ?? []) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) this.cookies[match[1]] = match[2];
    }
    // Fallback for environments without getSetCookie
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const part of setCookie.split(/,(?=\s*\w+=)/)) {
        const match = part.trim().match(/^([^=]+)=([^;]*)/);
        if (match) this.cookies[match[1]] = match[2];
      }
    }
  }

  header(): string {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

// ---------------------------------------------------------------------------
// VolleyManager client
// ---------------------------------------------------------------------------

async function followRedirects(
  url: string,
  jar: CookieJar,
  init: RequestInit = {},
  maxRedirects = 10,
): Promise<{ response: Response; body: string }> {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
  let currentUrl = url;

  for (let i = 0; i < maxRedirects; i++) {
    const resp = await fetch(currentUrl, {
      ...init,
      headers: { "User-Agent": ua, Cookie: jar.header(), ...(init.headers ?? {}) },
      redirect: "manual",
    });
    jar.update(resp);

    const status = resp.status;
    if (status >= 300 && status < 400) {
      const location = resp.headers.get("location");
      await resp.text(); // consume body
      if (!location) break;
      currentUrl = location.startsWith("http") ? location : `${VM_BASE}${location}`;
      // Redirects become GET
      init = {};
      continue;
    }

    const body = await resp.text();
    return { response: resp, body };
  }
  throw new Error(`Too many redirects from ${url}`);
}

async function vmLogin(
  username: string,
  password: string,
): Promise<{ jar: CookieJar; csrfToken: string }> {
  const jar = new CookieJar();

  // Step 1: GET login page → extract hidden fields
  console.log("VM: Getting login page...");
  const { body: loginHtml } = await followRedirects(`${VM_BASE}/login`, jar);

  const hiddenFields: Record<string, string> = {};
  const re = /name="([^"]+)"[^>]*value="([^"]*?)"/g;
  let m;
  while ((m = re.exec(loginHtml)) !== null) {
    hiddenFields[m[1]] = m[2];
  }
  console.log(`VM: Found ${Object.keys(hiddenFields).length} hidden fields`);
  console.log(`VM: Cookies after login page: ${Object.keys(jar.cookies).join(", ")}`);

  // Step 2: POST login (handle redirects manually to keep cookies)
  hiddenFields[
    "__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][username]"
  ] = username;
  hiddenFields[
    "__authentication[Neos][Flow][Security][Authentication][Token][UsernamePassword][password]"
  ] = password;

  console.log("VM: Posting login...");
  const { body: postLoginBody, response: postLoginResp } = await followRedirects(
    `${VM_BASE}/sportmanager.security/authentication/authenticate`,
    jar,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(hiddenFields).toString(),
    },
  );
  console.log(`VM: Post-login cookies: ${Object.keys(jar.cookies).join(", ")}`);

  // Step 3: GET referee page → extract CSRF from data-csrf-token attribute
  console.log("VM: Getting referee page for CSRF...");
  const { body: refHtml } = await followRedirects(
    `${VM_BASE}/indoorvolleyball.refadmin/refereegame/index`,
    jar,
  );

  const csrfMatch = refHtml.match(/data-csrf-token="([^"]+)"/);
  if (!csrfMatch) {
    // Debug: show what we got
    const titleMatch = refHtml.match(/<title>([^<]+)<\/title>/);
    console.error(`VM: Page title: ${titleMatch?.[1] ?? "unknown"}`);
    console.error(`VM: Page length: ${refHtml.length}`);
    console.error(`VM: Contains 'login': ${refHtml.includes("/login")}`);
    throw new Error("Could not find CSRF token after login");
  }

  console.log(`VM: CSRF found: ${csrfMatch[1].slice(0, 16)}...`);
  return { jar, csrfToken: csrfMatch[1] };
}

function buildSearchBody(csrfToken: string, offset: number, limit: number, dateFrom: string, dateTo: string): string {
  const params = new URLSearchParams();
  params.set("searchConfiguration[propertyFilters][0][propertyName]", "game.startingDateTime");
  params.set("searchConfiguration[propertyFilters][0][dateRange][from]", dateFrom);
  params.set("searchConfiguration[propertyFilters][0][dateRange][to]", dateTo);
  params.set("searchConfiguration[customFilters]", "");
  params.set("searchConfiguration[propertyOrderings][0][propertyName]", "game.startingDateTime");
  params.set("searchConfiguration[propertyOrderings][0][descending]", "false");
  params.set("searchConfiguration[propertyOrderings][0][isSetByUser]", "true");
  params.set("searchConfiguration[offset]", String(offset));
  params.set("searchConfiguration[limit]", String(limit));
  params.set("searchConfiguration[textSearchOperator]", "AND");
  RENDER_PROPERTIES.forEach((prop, i) => {
    params.set(`propertyRenderConfiguration[${i}]`, prop);
  });
  params.set("__csrfToken", csrfToken);
  return params.toString();
}

async function fetchAllGames(
  jar: CookieJar,
  csrfToken: string,
  dateFrom: string,
  dateTo: string,
): Promise<{ items: any[]; total: number }> {
  const url = `${VM_BASE}/api/indoorvolleyball.refadmin/api%5celasticsearchrefereegame/searchForManagingAssociation`;
  const ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
  const headers = {
    "User-Agent": ua,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: jar.header(),
  };

  // First batch
  const firstResp = await fetch(url, {
    method: "POST",
    headers,
    body: buildSearchBody(csrfToken, 0, BATCH_SIZE, dateFrom, dateTo),
  });

  if (!firstResp.ok) {
    const errBody = await firstResp.text();
    throw new Error(`VM API error: ${firstResp.status} - ${errBody.slice(0, 200)}`);
  }

  const firstResult = await firstResp.json();
  const total = firstResult.totalItemsCount ?? 0;
  const allItems = [...(firstResult.items ?? [])];
  console.log(`VM: ${total} total games, got ${allItems.length} in first batch`);

  // Paginate
  while (allItems.length < total) {
    await new Promise((r) => setTimeout(r, 100));
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: buildSearchBody(csrfToken, allItems.length, BATCH_SIZE, dateFrom, dateTo),
    });
    if (!resp.ok) break;
    const batch = await resp.json();
    const items = batch.items ?? [];
    if (items.length === 0) break;
    allItems.push(...items);
    if (allItems.length % 200 === 0 || allItems.length >= total) {
      console.log(`VM: ${allItems.length}/${total}`);
    }
  }

  return { items: allItems, total };
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

function deepGet(obj: any, ...keys: string[]): any {
  for (const k of keys) {
    if (obj && typeof obj === "object") obj = obj[k];
    else return null;
  }
  return obj ?? null;
}

function extractRefereeInfo(item: any, convocationKey: string) {
  const conv = item[convocationKey];
  if (!conv || typeof conv !== "object") return { name: null, firstName: null, lastName: null, dob: null };
  const person = deepGet(conv, "indoorAssociationReferee", "indoorReferee", "person");
  if (!person) return { name: null, firstName: null, lastName: null, dob: null };
  return {
    name: person.displayName ?? null,
    firstName: person.firstName ?? null,
    lastName: person.lastName ?? null,
    dob: person.formattedAndTimezoneIndependentBirthday ?? null,
  };
}

function transformGame(item: any): Record<string, any> {
  const g = item.game ?? {};
  const enc = g.encounter ?? {};
  const home = enc.teamHome ?? {};
  const away = enc.teamAway ?? {};
  const hall = g.hall ?? {};
  const addr = hall.primaryPostalAddress ?? {};
  const grp = g.group ?? {};
  const phase = grp.phase ?? {};
  const league = phase.league ?? {};
  const leagueCat = league.leagueCategory ?? {};

  // Referees
  const ref1 = extractRefereeInfo(item, "activeRefereeConvocationFirstHeadReferee");
  const ref2 = extractRefereeInfo(item, "activeRefereeConvocationSecondHeadReferee");

  // League classification
  const leagueName = (leagueCat.name ?? "") as string;
  const nameLower = leagueName.toLowerCase();
  const genderCode = league.gender ?? "";
  const isJunior = !!leagueCat.isJuniorLeagueCategory;

  const isCup = nameLower.includes("cup") || nameLower.includes("pokal");
  const matchType = isCup ? "cup" : "championship";
  const matchGender = genderCode === "m" ? "men" : genderCode === "f" ? "women" : "";

  const juniorKw = ["u14", "u15", "u16", "u17", "u18", "u19", "u20", "u23", "junior", "jugend", "nachwuchs"];
  let matchLevel = "senior";
  if (isJunior || juniorKw.some((kw) => nameLower.includes(kw))) matchLevel = "junior";

  // League text (e.g. "3L B", "1L D")
  const leagueShort = leagueCat.shortName ?? leagueName;
  const groupDisplay = grp.displayName ?? "";
  // Match "Gruppe B" or "#27051 | D"
  const gruppeMatch = groupDisplay.match(/Gruppe\s+([A-Z0-9]+)/)
    || groupDisplay.match(/\|\s*([A-Z0-9]+)\s*$/);
  const leagueText = gruppeMatch ? `${leagueShort} ${gruppeMatch[1]}` : leagueShort;

  // Match format
  const winSets = league.numberOfWinSets ?? "";
  const matchFormat = winSets === "two_win_sets" ? 3 : 5;

  // Date & time
  const rawDt = g.startingDateTime ?? "";
  let gameDate = "";
  let gameTime = "";
  if (rawDt) {
    try {
      const dt = new Date(rawDt);
      gameDate = `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
      gameTime = `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
    } catch {
      gameDate = rawDt.slice(0, 10);
    }
  }

  // Convocations
  const convocations: string[] = [];
  if (Array.isArray(item.refereeConvocations)) {
    for (const c of item.refereeConvocations) {
      const name = deepGet(c, "indoorAssociationReferee", "indoorReferee", "person", "displayName");
      if (name) convocations.push(name);
    }
  }

  return {
    game_number: String(g.number ?? ""),
    date: gameDate,
    time: gameTime,
    datetime: rawDt,
    city: addr.city ?? "",
    hall: hall.name ?? "",
    match_type: matchType,
    championship_type: ((nameLower.includes("1l") || nameLower.includes("1. liga")) && matchLevel === "senior") ? "national" : "regional",
    gender: matchGender,
    match_level: matchLevel,
    league: leagueText,
    match_format: matchFormat,
    team_home: home.name ?? "",
    team_away: away.name ?? "",
    referee_1: ref1.name ?? item.activeFirstHeadRefereeName ?? "",
    referee_1_first_name: ref1.firstName ?? "",
    referee_1_last_name: ref1.lastName ?? "",
    referee_1_dob: ref1.dob ?? null,
    referee_2: ref2.name ?? item.activeSecondHeadRefereeName ?? "",
    referee_2_first_name: ref2.firstName ?? "",
    referee_2_last_name: ref2.lastName ?? "",
    referee_2_dob: ref2.dob ?? null,
    hall_address: addr.combinedAddress ?? "",
    hall_postal_code: addr.postalCode ?? "",
    group_display: groupDisplay,
    phase_name: phase.name ?? "",
    linesman_1: item.activeFirstLinesmanRefereeName ?? "",
    linesman_2: item.activeSecondLinesmanRefereeName ?? "",
    is_supervised: !!item.isSupervised,
    has_supervised_referee: !!item.hasAtLeastOneRefereeIntendedToBeSupervised,
    convocations,
    synced_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  try {
    const startTime = Date.now();
    const url = new URL(req.url);

    const vmUser = Deno.env.get("VM_USERNAME")!;
    const vmPass = Deno.env.get("VM_PASSWORD")!;
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Date range: default today, override with ?date=2026-02-24 or ?from=...&to=...
    let dateFrom: string;
    let dateTo: string;
    const dateParam = url.searchParams.get("date");
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");

    if (fromParam && toParam) {
      dateFrom = `${fromParam}T00:00:00.000Z`;
      dateTo = `${toParam}T23:59:59.000Z`;
    } else if (dateParam) {
      dateFrom = `${dateParam}T00:00:00.000Z`;
      dateTo = `${dateParam}T23:59:59.000Z`;
    } else {
      const range = getTodayRange();
      dateFrom = range.from;
      dateTo = range.to;
    }

    const supabase = createClient(supabaseUrl, serviceKey);

    // Log start
    const { data: logEntry } = await supabase
      .from("svrz_sync_log")
      .insert({ status: "running" })
      .select("id")
      .single();
    const logId = logEntry?.id;

    console.log("Step 1: Logging into VolleyManager...");
    const { jar, csrfToken } = await vmLogin(vmUser, vmPass);
    console.log(`CSRF: ${csrfToken.slice(0, 16)}...`);

    console.log("Step 2: Fetching games...");
    console.log(`Date range: ${dateFrom} → ${dateTo}`);
    const { items, total } = await fetchAllGames(jar, csrfToken, dateFrom, dateTo);
    console.log(`Fetched ${items.length}/${total} games`);

    console.log("Step 3: Transforming and filtering...");
    const allRows = items
      .map(transformGame)
      .filter((r) => r.game_number);

    // Filter: only 1L and below (exclude NL/NLA/NLB)
    const rows = allRows.filter((r) => {
      const leagueLower = (r.league ?? "").toLowerCase();
      return !EXCLUDED_LEAGUES.some((ex) => leagueLower.includes(ex));
    });
    console.log(`Filtered: ${allRows.length} → ${rows.length} games (excluded ${allRows.length - rows.length} NL games)`);

    console.log("Step 4: Upserting to Supabase...");
    let created = 0;
    let updated = 0;
    let errors = 0;

    // Upsert in batches
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase
        .from("svrz_games")
        .upsert(batch, { onConflict: "game_number" });

      if (error) {
        console.error(`Batch error at offset ${i}:`, error.message);
        errors += batch.length;
      } else {
        // Count as updated (Supabase upsert doesn't distinguish)
        updated += batch.length;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const dateLabel = dateFrom.slice(0, 10) === dateTo.slice(0, 10)
      ? dateFrom.slice(0, 10)
      : `${dateFrom.slice(0, 10)} → ${dateTo.slice(0, 10)}`;
    const message = `[${dateLabel}] Synced ${rows.length} games in ${elapsed}s (${errors} errors)`;
    console.log(message);

    // Log finish
    if (logId) {
      await supabase.from("svrz_sync_log").update({
        finished_at: new Date().toISOString(),
        games_fetched: items.length,
        games_created: created,
        games_updated: updated,
        errors,
        status: errors === 0 ? "success" : "partial",
        message,
      }).eq("id", logId);
    }

    return new Response(
      JSON.stringify({ success: true, message, games: rows.length, dateFrom, dateTo }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("Sync failed:", err);
    return new Response(
      JSON.stringify({ success: false, error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
