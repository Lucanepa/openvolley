/**
 * sqlWorkspace — the manager's SQL tab: a Postgres console for super admins
 * (lib/manageApi.js). Two modes:
 *
 *   GET  /api/admin/sql/schema[?refresh=1]   the tables read mode sees, their
 *                                             columns, keys and value hints
 *                                             (sidebar + editor autocomplete)
 *   POST /api/admin/sql { sql, write_mode?, commit? }
 *        → { columns, rows, row_count, duration_ms, truncated, statements,
 *            write_mode, committed }
 *
 * Read mode (default): only SELECT / WITH / VALUES / SHOW / TABLE / EXPLAIN,
 * in a READ ONLY transaction as ov_readonly (backend/db/roles.sql) with the
 * search path on its schema ov_read: every table of public by its plain name,
 * without the secret columns (game PINs, token and code hashes), nothing of
 * auth. Always rolled back, also on success.
 *
 * Write mode: as the backend's own role (ov_app), with ov.user_id and
 * ov.admin set like an admin session of /api/db, and NOT ov.allow_closed, so
 * the closed-match lock of db/007 / db/039 holds. Without `commit: true` the
 * run is a preview: it runs whole and is rolled back, and the answer says
 * what it did (the rows of the last statement, or its row count). With
 * `commit: true` it runs again and commits. ov_app has no DDL rights: schema
 * changes stay migrations. ov_app reads every column, so write mode keeps
 * the secret columns (game PINs, token and code hashes) out itself: a
 * statement naming one is refused (checkWriteScope), so is one that reaches
 * one without its name (a whole row, an expression over SELECT *'s columns,
 * renamed columns: checkPlanSecrets on its EXPLAIN plan, before anything
 * runs), and the answer never carries one (SELECT *, RETURNING *: left out,
 * named in hidden_columns).
 *
 * Both modes: one transaction, statement_timeout 15 s, every statement
 * checked before anything runs (checkStatementPolicy: nothing that leaves
 * state on the pooled connection, reaches outside the database or plants
 * code / privileges), a bare SELECT capped at 1000 rows, every run audited
 * (sql.read / sql.write) with its string literals masked.
 *
 * Writes made here do not reach the realtime feed: a tablet sees them on
 * its next load.
 */

import pg from 'pg'
import { createHash } from 'node:crypto'
import { connectClient } from './pgClient.js'
import { fail, ok, unavailable } from './accounts.js'
import { SECRET_COLUMN_RE } from './dataAdmin.js'

const STATEMENT_TIMEOUT_MS = 15000
const DEFAULT_ROW_CAP = 1000
const SQL_MAX = 100000
const AUDIT_SQL_MAX = 1500
const SCHEMA_TTL_MS = 60_000
const VALUE_HINT_MAX = 40
const VALUE_HINT_MAX_DISTINCT = 40
export const READER_SCHEMA = 'ov_read'

// Temporal and binary values come back as Postgres prints them: a `date` must
// not become a JS Date at the server's midnight (it shifts a day in the
// browser), and a bytea Buffer would serialise as { type, data }.
const RAW_TYPES = new Set([
  1082, 1182, // date, date[]
  1083, 1183, // time
  1114, 1115, // timestamp
  1184, 1185, // timestamptz
  1266, 1270, // timetz
  1186, 1187, // interval
  17, 1001 // bytea
])
const queryTypes = {
  getTypeParser: (oid, format) => (RAW_TYPES.has(oid) ? (v) => v : pg.types.getTypeParser(oid, format))
}

/** The SQL as the audit log keeps it: every string literal as '?', at most 1500 characters. */
export function maskSql (sql) {
  let tokens
  try {
    tokens = lexSql(sql)
  } catch {
    return String(sql).slice(0, AUDIT_SQL_MAX).replace(/'[^']*'?/g, "'?'")
  }
  return tokens.map((t) => (t.type === 'string' ? "'?'" : t.text)).join('').slice(0, AUDIT_SQL_MAX)
}

// Sampled values of these columns never leave the database (the sidebar's hints)
const SENSITIVE_COLUMN = /name|mail|phone|mobile|birth|dob|address|street|zip|postal|sign|licen|sv_number|device|token|password|secret|hash|key|salt|pin|note|remark|reason|label|display|referee|scorer|coach|captain|official|player|staff|linesman/i

// Top-level DDL/DML keywords we consider "writes" — used for the error message.
// The GATE in read-only mode is the READ_KEYWORDS allowlist below, not this list:
// a blocklist missed COMMIT/END/ROLLBACK/BEGIN…, and `COMMIT; WITH d AS (DELETE …)`
// ended the READ ONLY transaction and ran the delete in autocommit (2026-09-28 audit).
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'COPY',
  'CREATE', 'ALTER', 'DROP', 'RENAME', 'GRANT', 'REVOKE',
  'COMMENT', 'CLUSTER', 'REINDEX', 'VACUUM', 'ANALYZE',
  'SET', 'RESET', 'DISCARD', 'LISTEN', 'NOTIFY', 'UNLISTEN',
  'CALL', 'DO', 'PREPARE', 'DEALLOCATE', 'EXECUTE',
  'LOCK', 'CHECKPOINT', 'IMPORT', 'LOAD', 'SECURITY', 'REFRESH',
  // Transaction control — any of these escapes the READ ONLY transaction.
  'BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT', 'RELEASE',
])

/** The ONLY leading keywords accepted in read-only mode. EXPLAIN ANALYZE of a
 *  write still hits the READ ONLY transaction; a data-modifying CTE likewise. */
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'SHOW', 'TABLE', 'EXPLAIN'])

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/
const SPACE = /\s/

/** Lex SQL into tokens the way Postgres does: string literals (incl. E'…'
 *  backslash escapes and $tag$…$tag$ dollar quotes), quoted identifiers, line
 *  comments and NESTED block comments are single tokens, so nothing inside
 *  them is ever read as code. Any disagreement with Postgres is a way to hide
 *  code from the guards below, so an unterminated literal/comment throws
 *  instead of guessing. Token types: ws, comment, string, qident, word,
 *  semicolon, other (one punctuation/operator character). Concatenating every
 *  token's `text` gives back the input exactly. */
export function lexSql(sql) {
  const tokens = []
  let i = 0
  const n = sql.length
  const fail = () => {
    const err = new Error('Unterminated string, identifier or comment')
    err.status = 400
    err.code = 'unterminated'
    throw err
  }
  const push = (type, end) => {
    tokens.push({ type, text: sql.slice(i, end) })
    i = end
  }
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    const prev = i > 0 ? sql[i - 1] : ''
    // Line comment
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      push('comment', nl === -1 ? n : nl + 1)
      continue
    }
    // Block comment — Postgres nests them.
    if (c === '/' && next === '*') {
      let depth = 0
      let j = i
      while (j < n) {
        if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue }
        if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      if (depth !== 0) fail()
      push('comment', j)
      continue
    }
    // E'…' escape string: backslash escapes the next char ('' still works too).
    if ((c === 'E' || c === 'e') && next === "'" && !IDENT_CHAR.test(prev)) {
      let j = i + 2
      let closed = false
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) fail()
      push('string', j)
      continue
    }
    // Standard string (standard_conforming_strings = on: no backslash escapes).
    if (c === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue }
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) fail()
      push('string', j)
      continue
    }
    // Quoted identifier
    if (c === '"') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue }
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) fail()
      push('qident', j)
      continue
    }
    // Dollar quote $tag$…$tag$ (not $1 params, not mid-identifier like a$b).
    if (c === '$' && !IDENT_CHAR.test(prev)) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        if (close === -1) fail()
        push('string', close + tag.length)
        continue
      }
    }
    if (c === ';') { push('semicolon', i + 1); continue }
    if (SPACE.test(c)) {
      let j = i + 1
      while (j < n && SPACE.test(sql[j])) j++
      push('ws', j)
      continue
    }
    // A run of identifier characters. None of the constructs above can start
    // inside the run: each needs a non-identifier character or a
    // non-identifier predecessor, so the run ends exactly where the
    // character-by-character scan would have found one.
    if (IDENT_CHAR.test(c)) {
      let j = i + 1
      while (j < n && IDENT_CHAR.test(sql[j])) j++
      push('word', j)
      continue
    }
    push('other', i + 1)
  }
  return tokens
}

/** Split SQL into statements at top-level `;` (see lexSql — a `;` inside a
 *  literal, identifier or comment is not a boundary). Returns trimmed
 *  non-empty statements. */
export function splitStatements(sql) {
  const out = []
  let buf = ''
  for (const tok of lexSql(sql)) {
    if (tok.type === 'semicolon') {
      const trimmed = buf.trim()
      if (trimmed) out.push(trimmed)
      buf = ''
      continue
    }
    buf += tok.text
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  // Comment-only chunks (`SELECT 1; -- note`) are not statements.
  return out.filter((st) => stripLeadingComments(st) !== '')
}

/** Strip leading whitespace and line/block comments (nested). */
function stripLeadingComments(stmt) {
  let s = stmt
  while (true) {
    s = s.replace(/^\s+/, '')
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n')
      s = nl === -1 ? '' : s.slice(nl + 1)
      continue
    }
    if (s.startsWith('/*')) {
      let depth = 0
      let j = 0
      while (j < s.length) {
        if (s[j] === '/' && s[j + 1] === '*') { depth++; j += 2; continue }
        if (s[j] === '*' && s[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue }
        j++
      }
      s = depth === 0 ? s.slice(j) : ''
      continue
    }
    return s
  }
}

/** First keyword after leading comments (uppercased), or '' if none. */
export function leadingKeyword(stmt) {
  // Strip an opening parenthesis (e.g. `(SELECT ...)`)
  const s = stripLeadingComments(stmt).replace(/^\(+/, '')
  const m = s.match(/^([A-Za-z]+)/)
  return m ? m[1].toUpperCase() : ''
}

/** True iff this single-statement SQL is a bare SELECT/WITH/VALUES/SHOW with
 *  no existing LIMIT clause at the end. Heuristic — good enough for the
 *  auto-cap. */
function shouldAutoLimit(stmt) {
  const kw = leadingKeyword(stmt)
  if (kw !== 'SELECT' && kw !== 'WITH' && kw !== 'VALUES' && kw !== 'SHOW' && kw !== 'TABLE') {
    return false
  }
  // Quick: contains the word LIMIT followed by whitespace/digits anywhere in
  // the tail half of the string. Slightly over-permissive but the cost of a
  // false-skip is just "no auto cap" — the timeout still applies.
  return !/\blimit\b\s+\d/i.test(stmt)
}

// ── Statement policy (both modes) ────────────────────────────────────────────
// READ ONLY stops writes to tables, not everything that outlives a request:
// the connection goes back to the pool afterwards, so a session-level SET /
// set_config(…, false), an advisory lock or a LISTEN would carry over into
// whichever request drew that connection next. OpenVolley's database guards
// are exactly such settings: ov.allow_closed and ov.admin open the closed-match
// lock of db/007 and db/039, ov.user_id names the actor. Read mode always rolls
// back, which undoes SET; these refusals cover what a rollback does not (locks,
// terminated backends), write mode (which commits), and SET ROLE's way back out
// of the reader role. They also keep code (functions, triggers, rules, DO) out
// of the database: schema changes of that kind belong in a reviewed migration.
//
// Matching runs on lexSql() tokens, so string literals and comments never
// match, quoted identifiers are unwrapped, and every part of a schema-qualified
// name is checked. All names are lower-cased (an upper-case quoted name is a
// different, nonexistent function — refusing it costs nothing).

const MIGRATION_HINT = 'Functions, triggers, rules, roles, grants and ownership changes belong in a numbered migration ' +
  '(escoresheet/backend/db/NNN_*.sql), where they are reviewed.'
/** Read mode: what a 42501 from the reader role means. */
export const CREDENTIAL_DENIED_HINT = 'Read mode reads the tables by their plain names (matches, not public.matches), ' +
  'without their secret columns (game PINs, token and code hashes) and without the sign-in data (auth). ' +
  'Write mode works on the tables themselves.'
const POOLED_HINT = 'The workspace borrows a pooled database connection that later requests reuse, so nothing it runs may ' +
  'leave session state behind.'

const TX_CONTROL = 'each run is already exactly one transaction (read mode always rolls back, write mode commits once ' +
  'at the end) — remove the transaction control'
/** Leading keywords refused in both modes → why. */
const SESSION_STATEMENTS = new Map([
  ['set', 'changes a setting on the connection — read one with SHOW or current_setting()'],
  ['reset', 'changes a setting on the connection — read one with SHOW or current_setting()'],
  ['discard', 'resets session state on the connection'],
  ['listen', 'subscribes the connection to notifications'],
  ['unlisten', 'changes the connection\'s notification subscriptions'],
  ['notify', 'sends a notification'],
  ['load', 'loads a server library'],
  ['copy', 'copies to or from the server — export from the result grid instead'],
  ['prepare', 'creates a prepared statement or transaction that outlives the request'],
  ['deallocate', 'drops prepared statements on the connection'],
  ['execute', 'runs a prepared statement'],
  ['begin', TX_CONTROL], ['start', TX_CONTROL], ['commit', TX_CONTROL], ['end', TX_CONTROL],
  ['rollback', TX_CONTROL], ['abort', TX_CONTROL], ['savepoint', TX_CONTROL], ['release', TX_CONTROL],
])

/** Functions refused in both modes: [pattern, why]. */
const BLOCKED_FUNCTIONS = [
  [/^set_config$/, 'changes a setting on the connection'],
  [/^pg_(try_)?advisory_/, 'takes an advisory lock that can outlive the request'],
  [/^pg_(terminate|cancel)_backend$/, 'stops other database sessions'],
  [/^pg_(reload_conf|rotate_logfile)$/, 'administers the server'],
  [/_to_xml(schema|_and_xmlschema)?$/, 'runs SQL passed to it as text'],
  [/^ts_(stat|rewrite)$/, 'runs SQL passed to it as text'],
  [/^dblink/, 'opens connections to other databases'],
  [/^lo_|^lo(read|write)$/, 'reads or writes large objects and server files'],
  [/^pg_read_(binary_)?file$|^pg_ls_|^pg_stat_file$|^pg_file_/, 'reads or writes server files'],
  [/^pg_notify$/, 'sends a notification'],
  [/^pg_(create|drop|copy)_|^pg_(logical|replication)_/, 'administers replication'],
  [/^pg_(switch_wal|promote|backup_start|backup_stop|start_backup|stop_backup|import_system_collations|log_backend_memory_contexts)$|^pg_stat_reset/, 'administers the server'],
]

/** CREATE / ALTER / DROP of these objects is refused in both modes. */
const DDL_VERBS = new Set(['create', 'alter', 'drop'])
/** Words between the verb and the object (`CREATE OR REPLACE TRUSTED LANGUAGE`,
 *  `CREATE CONSTRAINT TRIGGER`, `ALTER DEFAULT PRIVILEGES`, `CREATE TEMP …`). */
const DDL_MODIFIERS = new Set([
  'or', 'replace', 'constraint', 'trusted', 'procedural', 'default',
  'global', 'local', 'temp', 'temporary', 'unlogged', 'recursive',
])
const DDL_OBJECTS = new Set([
  'function', 'procedure', 'routine', 'trigger', 'event', 'rule', 'aggregate',
  'operator', 'cast', 'language', 'extension', 'transform', 'conversion',
  'role', 'user', 'group', 'policy', 'privileges', 'owned', 'system', 'database',
  'tablespace', 'server', 'foreign', 'publication', 'subscription', 'access', 'large',
])

function refusal(code, message, hint) {
  return { code, message, hint }
}

/** A word or quoted identifier's name, lower-cased; null for anything else. */
function tokenName(tok) {
  if (tok.type === 'word') return tok.text.toLowerCase()
  if (tok.type === 'qident') return tok.text.slice(1, -1).replace(/""/g, '"').toLowerCase()
  return null
}

/**
 * Refuse a single statement that would leave state behind on the pooled
 * connection, reach outside the database, or plant code/privileges — in BOTH
 * modes. Pure; exported for the unit test.
 * @returns {null | { code: string, message: string, hint: string }}
 */
export function checkStatementPolicy(stmt) {
  const raw = lexSql(stmt)

  // U&"…" identifiers spell names with escapes (U&"set\005fconfig"); nothing
  // legitimate needs one, so refuse it rather than decode it.
  for (let k = 0; k + 2 < raw.length; k++) {
    if (raw[k].type === 'word' && /[uU]$/.test(raw[k].text)
      && raw[k + 1].type === 'other' && raw[k + 1].text === '&' && raw[k + 2].type === 'qident') {
      return refusal('statement_not_allowed', 'Unicode-escaped identifiers (U&"…") are not allowed in the SQL workspace',
        'Write the identifier plainly.')
    }
  }

  // Significant tokens only: whitespace and comments dropped; strings kept as
  // opaque placeholders so they never match a name.
  const sig = raw.filter((t) => t.type !== 'ws' && t.type !== 'comment')
  const isWord = (k, ...words) => sig[k]?.type === 'word' && words.includes(sig[k].text.toLowerCase())
  const names = sig.map(tokenName).filter((v) => v !== null)

  let lead = 0
  while (sig[lead]?.type === 'other' && sig[lead].text === '(') lead++
  const leadWord = sig[lead]?.type === 'word' ? sig[lead].text.toLowerCase() : ''

  // SET CONSTRAINTS only defers FK checks to the end of this transaction.
  // Every other SET form — SET LOCAL included — could switch the statement
  // timeout, the READ ONLY mode or the reader role back off mid-run.
  const setConstraints = leadWord === 'set' && isWord(lead + 1, 'constraints')
  if (SESSION_STATEMENTS.has(leadWord) && !setConstraints) {
    return refusal('statement_not_allowed',
      `${leadWord.toUpperCase()} is not allowed in the SQL workspace: it ${SESSION_STATEMENTS.get(leadWord)}`, POOLED_HINT)
  }
  if (leadWord === 'declare' && names.includes('hold')) {
    return refusal('statement_not_allowed', 'DECLARE … WITH HOLD is not allowed in the SQL workspace: the cursor outlives the request',
      POOLED_HINT)
  }
  if (leadWord === 'do' || leadWord === 'reassign' || leadWord === 'import') {
    return refusal('ddl_not_allowed', `${leadWord.toUpperCase()} is not allowed in the SQL workspace`, MIGRATION_HINT)
  }

  for (const name of names) {
    for (const [re, why] of BLOCKED_FUNCTIONS) {
      if (re.test(name)) {
        return refusal('function_not_allowed', `Function "${name}" is not allowed in the SQL workspace: it ${why}`, POOLED_HINT)
      }
    }
    if (/^pg_temp(_\d+)?$/.test(name)) {
      return refusal('statement_not_allowed', 'Temporary objects are not allowed in the SQL workspace', POOLED_HINT)
    }
  }

  // pg_settings has an UPDATE rule that calls set_config — it is SET by another
  // name, and write mode commits it onto the pooled connection. (Read mode's
  // READ ONLY refuses the rewritten query; refused there too for one rule.)
  if (names.includes('pg_settings') && names.includes('update')) {
    return refusal('statement_not_allowed', 'Updating pg_settings is not allowed in the SQL workspace: it changes settings on the connection',
      POOLED_HINT)
  }

  for (let k = 0; k < sig.length; k++) {
    // Temporary tables survive a commit on the pooled connection and are found
    // before public tables of the same name by every later request.
    if (isWord(k, 'temp', 'temporary') && isWord(k - 1, 'create', 'replace', 'local', 'global', 'into')) {
      return refusal('statement_not_allowed', 'Temporary tables are not allowed in the SQL workspace: they outlive the request on the connection',
        POOLED_HINT)
    }
    if (isWord(k, ...DDL_VERBS)) {
      let j = k + 1
      while (isWord(j, ...DDL_MODIFIERS)) j++
      if (sig[j]?.type === 'word' && DDL_OBJECTS.has(sig[j].text.toLowerCase())) {
        return refusal('ddl_not_allowed',
          `${sig[k].text.toUpperCase()} ${sig[j].text.toUpperCase()} is not allowed in the SQL workspace`, MIGRATION_HINT)
      }
    }
    if (isWord(k, 'enable', 'disable')) {
      let j = k + 1
      while (isWord(j, 'replica', 'always')) j++
      if (isWord(j, 'trigger', 'rule')) {
        return refusal('ddl_not_allowed',
          `${sig[k].text.toUpperCase()} ${sig[j].text.toUpperCase()} is not allowed in the SQL workspace: triggers and rules are the database's guards`,
          MIGRATION_HINT)
      }
    }
    if (isWord(k, 'owner') && isWord(k + 1, 'to')) {
      return refusal('ddl_not_allowed', 'Ownership changes (OWNER TO) are not allowed in the SQL workspace', MIGRATION_HINT)
    }
    if (isWord(k, 'grant', 'revoke', 'authorization')) {
      return refusal('ddl_not_allowed', `${sig[k].text.toUpperCase()} is not allowed in the SQL workspace`, MIGRATION_HINT)
    }
  }
  return null
}


const SECRET_HINT = 'A game PIN is read or reset in Closed matches; token and code hashes are never needed by hand.'
const WHOLE_ROW_HINT = 'Name the columns you need (SELECT * is fine: its secret columns are left out of the answer).'
// Words after `)` that never start a column alias list (`count(*) FILTER (`, `OVER (`, `(a, b) IN (`, `VALUES (`, ...)
const NOT_AN_ALIAS = new Set(['filter', 'over', 'within', 'in', 'and', 'or', 'not', 'values', 'exists', 'any', 'all', 'some',
  'then', 'else', 'when', 'like', 'ilike', 'similar', 'is', 'between', 'on', 'using', 'select', 'from', 'where', 'group',
  'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'window', 'returning', 'set', 'into', 'join',
  'lateral', 'case', 'end', 'array', 'row', 'distinct', 'overlaps', 'escape', 'collate', 'at', 'with', 'by', 'cross',
  'inner', 'left', 'right', 'full', 'natural', 'outer', 'do', 'conflict', 'update', 'delete', 'insert', 'merge', 'matched',
  'tablesample', 'repeatable', 'ordinality', 'for', 'of', 'nulls', 'asc', 'desc', 'fetch', 'first', 'next', 'only', 'ties'])
// Types written with a size after AS: CAST(x AS numeric(4,2)) is no alias list
const SIZED_TYPES = new Set(['numeric', 'decimal', 'dec', 'varchar', 'char', 'character', 'bpchar', 'bit', 'varbit', 'timestamp',
  'timestamptz', 'time', 'timetz', 'interval', 'float', 'nchar', 'national'])

/**
 * Write mode runs as the backend role, which may read the sign-in data
 * (auth.users, sessions, passkeys) and the secret columns: refused here, so
 * write mode reaches no more than read mode plus the writes themselves.
 * `secretRelations` (the names of the tables and views that have a secret
 * column; sqlWorkspace's run passes them): a statement naming one may not
 * give columns new names (`matches AS m(a, b, c)`, `(…) AS s(a, b)`,
 * `WITH t(a, b) AS (…)`), which would carry a secret column under another
 * name past the checks (SEC-40). Pure; exported for the unit test.
 * @param {string} stmt
 * @param {{ secretRelations?: Set<string> }} [opts]
 * @returns {null | { code: string, message: string, hint: string }}
 */
export function checkWriteScope (stmt, { secretRelations = null } = {}) {
  const sig = lexSql(stmt).filter((t) => t.type !== 'ws' && t.type !== 'comment')
  const isOther = (k, text) => sig[k]?.type === 'other' && sig[k].text === text
  const isWord = (k, ...words) => sig[k]?.type === 'word' && words.includes(sig[k].text.toLowerCase())
  let mentionsSecret = false
  for (let k = 0; k < sig.length; k++) {
    const name = tokenName(sig[k])
    if (name === null) continue
    if (name === 'auth' && sig[k + 1]?.type === 'other' && sig[k + 1].text === '.') {
      return refusal('auth_not_allowed', 'The sign-in data (schema auth) is not reachable from the SQL workspace',
        'Accounts are changed in Accounts (names, addresses, roles, deactivation, deletion).')
    }
    if (SECRET_COLUMN_RE.test(name)) {
      return refusal('secret_column_not_allowed', `"${name}" is a secret column: not reachable from the SQL workspace`, SECRET_HINT)
    }
    if (secretRelations?.has(name) && !isOther(k + 1, '.')) mentionsSecret = true
  }
  if (!mentionsSecret) return null
  const renamed = () => refusal('column_alias_not_allowed',
    'Column alias lists are not allowed in write mode on a statement that reads a table with secret columns',
    'Rename columns in the select list instead (SELECT a AS b).')
  for (let k = 0; k < sig.length; k++) {
    const name = tokenName(sig[k])
    // matches [AS] m (a, b, …): the table's own columns under new names (INSERT INTO t AS x (cols) is the insert's column list)
    if (name !== null && secretRelations.has(name) && !isOther(k + 1, '.') && !isWord(k - 1, 'into') &&
        !(isOther(k - 1, '.') && !isWord(k - 2, 'public'))) {
      let j = k + 1
      if (isWord(j, 'as')) j++
      if ((sig[j]?.type === 'word' || sig[j]?.type === 'qident') && !NOT_AN_ALIAS.has(tokenName(sig[j])) && isOther(j + 1, '(')) return renamed()
    }
    if (isOther(k, ')')) {
      // WITH t (a, b) AS [NOT] [MATERIALIZED] (…): a common table expression's columns renamed
      let j = k + 1
      if (isWord(j, 'as')) {
        let m = j + 1
        if (isWord(m, 'not')) m++
        if (isWord(m, 'materialized')) m++
        if (isOther(m, '(')) return renamed()
      }
      // (…) [AS] s (a, b): a subquery's or function's columns renamed
      const as = isWord(j, 'as')
      if (as) j++
      const alias = sig[j] ? tokenName(sig[j]) : null
      if (alias !== null && (as ? !SIZED_TYPES.has(alias) : !NOT_AN_ALIAS.has(alias)) && isOther(j + 1, '(')) return renamed()
    }
  }
  return null
}

// ── Write mode: the plan's view of secret columns (SEC-40) ───────────────────
// A name-based check cannot see a secret column reached without its name: a
// whole row (SELECT m, row_to_json(m), m::text, ROW(m.*)) or an expression
// over SELECT *'s columns. EXPLAIN (VERBOSE) names every column a plan reads
// or computes with, so each write-mode statement is planned first (nothing
// runs) and refused when a secret column is used anywhere but as a plain
// output column, which the answer then leaves out.

const PLAN_NAME_KEYS = new Set(['Node Type', 'Parent Relationship', 'Relation Name', 'Schema', 'Alias', 'Index Name', 'Strategy',
  'Partial Mode', 'Join Type', 'Scan Direction', 'Operation', 'Sort Method', 'Sort Space Type', 'Subplan Name', 'CTE Name',
  'Conflict Resolution', 'Conflict Arbiter Indexes', 'Command', 'Function Name', 'Trigger Name', 'Constraint Name',
  'Custom Plan Provider', 'Setop', 'Remote SQL', 'Tuplestore Name', 'Async Capable'])
// where a plain column is only passed on or ordered by (never computed with)
const PLAN_PASS_KEYS = new Set(['Output', 'Sort Key', 'Presorted Key', 'Group Key'])
const PART = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
const PLAN_IDENT_RE = new RegExp(`${PART}(?:\\.(?:${PART}|\\*))*`, 'g')
const PLAN_BARE_RE = new RegExp(`^${PART}(?:\\.${PART})*(?:\\s+(?:ASC|DESC))?(?:\\s+NULLS\\s+(?:FIRST|LAST))?$`)
const unquote = (p) => (p.startsWith('"') ? p.slice(1, -1).replace(/""/g, '"') : p.toLowerCase())

/**
 * The plan of one statement (EXPLAIN (VERBOSE, FORMAT JSON)) against the
 * secret columns. `secretRelations`: "schema.name" of every table or view
 * with a secret column. Refuses: a whole row (alias.*) of such a table, or of
 * a subquery / CTE / function when the plan reads such a table; a secret
 * column inside an expression, a condition or a key; and, in a statement
 * that writes, a secret column passed on into the write. Pure; exported for
 * the unit test.
 * @returns {null | { code: string, message: string, hint: string }}
 */
export function checkPlanSecrets (explained, { secretRelations = new Set() } = {}) {
  const roots = (Array.isArray(explained) ? explained : [explained]).map((x) => x?.Plan || x).filter(Boolean)
  const aliases = new Map() // alias -> secret?
  let writes = false
  let readsSecret = false
  const visit = (node, fn, modify = false) => {
    if (!node || typeof node !== 'object') return
    const isModify = node['Node Type'] === 'ModifyTable'
    fn(node, isModify || modify)
    for (const child of node.Plans || []) visit(child, fn, false)
  }
  for (const r of roots) {
    visit(r, (node) => {
      if (node['Node Type'] === 'ModifyTable') writes = true
      if (typeof node['Relation Name'] === 'string') {
        const secret = secretRelations.has(`${node.Schema || 'public'}.${node['Relation Name']}`)
        if (secret) readsSecret = true
        if (typeof node.Alias === 'string') aliases.set(node.Alias.toLowerCase(), secret || aliases.get(node.Alias.toLowerCase()) === true)
      }
    })
  }
  let found = null
  const check = (text, key, inModify) => {
    const s = String(text).replace(/'(?:[^']|'')*'/g, "''")
    const bare = PLAN_PASS_KEYS.has(key) && PLAN_BARE_RE.test(s.trim())
    PLAN_IDENT_RE.lastIndex = 0
    let m
    while (!found && (m = PLAN_IDENT_RE.exec(s))) {
      const after = s.slice(m.index + m[0].length).trimStart()
      const before = s.slice(0, m.index).trimEnd()
      if (after.startsWith('(') || before.endsWith('::')) continue // a function or a type
      const parts = m[0].match(new RegExp(`${PART}|\\*`, 'g'))
      const last = parts.at(-1)
      if (last === '*') {
        const alias = unquote(parts.at(-2) || '')
        const known = aliases.has(alias)
        if ((known && aliases.get(alias)) || (!known && readsSecret)) {
          found = refusal('whole_row_not_allowed', `A whole row (${alias}.*) of a table with secret columns is not allowed in write mode`, WHOLE_ROW_HINT)
        }
        continue
      }
      if (SECRET_COLUMN_RE.test(unquote(last)) && !(bare && (!writes || inModify))) {
        found = refusal('secret_column_not_allowed', `The secret column "${unquote(last)}" may not be used in write mode, also not without its name`, SECRET_HINT)
      }
    }
  }
  for (const r of roots) {
    visit(r, (node, inModify) => {
      for (const [key, v] of Object.entries(node)) {
        if (found || key === 'Plans' || PLAN_NAME_KEYS.has(key)) continue
        if (typeof v === 'string') check(v, key, inModify)
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') check(x, key, inModify)
      }
    })
  }
  return found
}

/** The leading keywords EXPLAIN takes. */
const EXPLAINABLE = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DECLARE'])
const SECRET_COLUMN_SQL_RE = SECRET_COLUMN_RE.source

// ── The runner ──────────────────────────────────────────────────────────────

/** A Postgres error of a statement as the console's answer (400, its own words). */
function statementError (pgErr, index, writeMode) {
  const message = String(pgErr?.message || 'query failed').slice(0, 1000)
  const details = {
    detail: pgErr?.detail ?? null,
    hint: pgErr?.hint ?? null,
    position: pgErr?.position ?? null,
    statement_index: index
  }
  // Read mode runs as the reader role: a table of public by its schema name,
  // a secret column or auth comes back as 42501
  if (!writeMode && pgErr?.code === '42501') {
    return fail(400, 'credential_column_denied', `${message}: read mode has no access to that`, { ...details, detail: message, hint: CREDENTIAL_DENIED_HINT })
  }
  if (writeMode && pgErr?.code === '42501') {
    return fail(400, String(pgErr.code), message, { ...details, hint: details.hint || 'Write mode runs as the backend role: no schema changes (those are migrations), no sign-in data.' })
  }
  if (pgErr?.code === 'OVC01' || pgErr?.code === 'OVC02') {
    return fail(409, String(pgErr.code), message, { ...details, hint: 'A closed match is reopened first (Closed matches), which keeps its record.' })
  }
  return fail(400, String(pgErr?.code || 'pg_error'), message, details)
}

/**
 * @param {{ pool: import('pg').Pool, audit: Function, readerRole?: string, logger?: Console }} deps
 *   audit: lib/accounts.js audit(client, entry); readerRole: OV_SQL_READER_ROLE (tests), default ov_readonly
 */
export function createSqlWorkspace ({ pool, audit, readerRole = 'ov_readonly', logger = console }) {
  const log = logger || console
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(readerRole)) throw new Error(`sqlWorkspace: invalid reader role ${readerRole}`)
  let schemaCache = null

  async function withClient (fn) {
    const client = await connectClient(pool, log)
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  /** BEGIN READ ONLY as the reader role, on ov_read; always rolled back. */
  async function asReader (client, fn) {
    await client.query('BEGIN READ ONLY')
    try {
      await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      await client.query(`SET LOCAL ROLE "${readerRole}"`)
      await client.query(`SET LOCAL search_path = ${READER_SCHEMA}, pg_catalog`)
      return await fn()
    } finally {
      try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
    }
  }

  // ---------------------------------------------------------------- schema

  async function loadSchema (force) {
    if (!force && schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.model
    const model = await withClient(async (client) => {
      // The columns read mode sees: ov_read's views, read AS the reader role
      const cols = await asReader(client, () => client.query(
        `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
           FROM information_schema.columns c
          WHERE c.table_schema = $1
          ORDER BY c.table_name, c.ordinal_position`, [READER_SCHEMA]))
      const byTable = new Map()
      for (const r of cols.rows) {
        let t = byTable.get(r.table_name)
        if (!t) {
          t = { name: r.table_name, columns: [] }
          byTable.set(r.table_name, t)
        }
        t.columns.push({ name: r.column_name, data_type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type, nullable: r.is_nullable === 'YES' })
      }
      // Keys and value hints come from the tables behind the views (best effort)
      const keys = new Map()
      try {
        const { rows } = await client.query(
          `SELECT con.contype, cl.relname AS table_name, att.attname AS column_name,
                  fcl.relname AS foreign_table, fatt.attname AS foreign_column
             FROM pg_constraint con
             JOIN pg_class cl ON cl.oid = con.conrelid
             JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = 'public'
             JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
             LEFT JOIN pg_class fcl ON fcl.oid = con.confrelid
             LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS fk(attnum, ord) ON fk.ord = k.ord
             LEFT JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = fk.attnum
            WHERE con.contype IN ('p', 'f')`)
        for (const r of rows) {
          const key = `${r.table_name}.${r.column_name}`
          const e = keys.get(key) || {}
          if (r.contype === 'p') e.pk = true
          else if (r.foreign_table) e.ref = `${r.foreign_table}.${r.foreign_column}`
          keys.set(key, e)
        }
      } catch (err) {
        log.warn?.(`[sql] key introspection failed: ${err?.message}`)
      }
      const values = new Map()
      try {
        const { rows } = await client.query(
          `SELECT c.table_name, c.column_name, e.enumlabel
             FROM information_schema.columns c
             JOIN pg_type pt ON pt.typname = c.udt_name
             JOIN pg_enum e ON e.enumtypid = pt.oid
            WHERE c.table_schema = 'public'
            ORDER BY c.table_name, c.column_name, e.enumsortorder`)
        for (const r of rows) {
          const key = `${r.table_name}.${r.column_name}`
          const list = values.get(key) || []
          if (list.length < VALUE_HINT_MAX) list.push(r.enumlabel)
          values.set(key, list)
        }
        const stats = await client.query(
          `SELECT s.tablename, s.attname, s.most_common_vals::text::text[] AS vals
             FROM pg_stats s
             JOIN information_schema.columns c
               ON c.table_schema = s.schemaname AND c.table_name = s.tablename AND c.column_name = s.attname
            WHERE s.schemaname = 'public' AND s.most_common_vals IS NOT NULL
              AND s.n_distinct > 0 AND s.n_distinct <= ${VALUE_HINT_MAX_DISTINCT}
              AND c.data_type IN ('character varying', 'text', 'character')`)
        for (const r of stats.rows) {
          const key = `${r.tablename}.${r.attname}`
          if (values.has(key) || SENSITIVE_COLUMN.test(r.attname)) continue
          const list = (r.vals || []).filter((v) => typeof v === 'string' && v !== '' && v.length <= 60).slice(0, VALUE_HINT_MAX).sort((a, b) => a.localeCompare(b))
          if (list.length) values.set(key, list)
        }
      } catch (err) {
        log.warn?.(`[sql] value hints failed: ${err?.message}`)
      }
      const tables = [...byTable.values()].map((t) => ({
        name: t.name,
        columns: t.columns.map((c) => {
          const key = `${t.name}.${c.name}`
          const k = keys.get(key)
          const v = values.get(key)
          return { ...c, ...(k?.pk ? { pk: true } : {}), ...(k?.ref ? { ref: k.ref } : {}), ...(v?.length ? { values: v } : {}) }
        })
      }))
      const { rows: [ver] } = await client.query("SELECT current_setting('server_version') AS v")
      return { tables, server_version: ver?.v || null, generated_at: new Date().toISOString() }
    })
    schemaCache = { at: Date.now(), model }
    return model
  }

  async function schema ({ force = false } = {}) {
    try {
      return ok(await loadSchema(force))
    } catch (err) {
      log.error?.(`[sql] schema failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      if (err?.code === '42704' || err?.code === '42501') {
        return fail(503, 'OV_SQL_READER_MISSING', 'The reader role is missing: run apply-roles.sh < roles.sql on the server.')
      }
      return unavailable()
    }
  }

  // ---------------------------------------------------------------- run

  async function run ({ actorId, body }) {
    const started = Date.now()
    const sqlText = String(body?.sql ?? '').trim()
    const writeMode = body?.write_mode === true
    const commit = writeMode && body?.commit === true
    if (!sqlText) return fail(400, 'sql_required', 'SQL required')
    if (sqlText.length > SQL_MAX) return fail(400, 'sql_too_large', 'SQL too large (max 100 KB)')
    let statements
    try {
      statements = splitStatements(sqlText)
    } catch (err) {
      return fail(400, err.code || 'unterminated', err.message)
    }
    if (statements.length === 0) return fail(400, 'sql_required', 'No statements to run')
    // Every check on every statement before anything runs: a script is refused whole
    for (let i = 0; i < statements.length; i++) {
      const refused = checkStatementPolicy(statements[i])
      if (refused) return fail(400, refused.code, refused.message, { hint: refused.hint, statement_index: i })
    }
    if (writeMode) {
      for (let i = 0; i < statements.length; i++) {
        const refused = checkWriteScope(statements[i])
        if (refused) return fail(400, refused.code, refused.message, { hint: refused.hint, statement_index: i })
      }
    }
    if (!writeMode) {
      for (let i = 0; i < statements.length; i++) {
        const kw = leadingKeyword(statements[i])
        if (!READ_KEYWORDS.has(kw)) {
          return fail(400, 'write_required', WRITE_KEYWORDS.has(kw)
            ? `"${kw}" needs write mode`
            : `Read mode runs SELECT, WITH, VALUES, SHOW, TABLE and EXPLAIN only${kw ? ` (not "${kw}")` : ''}`, { statement_index: i })
        }
      }
    }

    const lastIdx = statements.length - 1
    let out = { columns: [], rows: [], row_count: 0, truncated: false }
    const refuse = (i, r) => Object.assign(new Error('refused'), { __result: fail(400, r.code, r.message, { hint: r.hint, statement_index: i }) })
    /**
     * Write mode, before anything runs: the tables with secret columns, then
     * each statement's renamed columns (checkWriteScope) and its plan
     * (checkPlanSecrets). EXPLAIN runs nothing. Returns what the answer
     * leaves out: the secret columns by table oid and column number.
     */
    const guardSecrets = async (client) => {
      const { rows: cols } = await client.query(
        `SELECT n.nspname, c.relname, c.oid::bigint AS oid, a.attnum::int AS attnum
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped AND a.attname ~ $1
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`, [SECRET_COLUMN_SQL_RE])
      const secretRelations = new Set(cols.map((r) => `${r.nspname}.${r.relname}`))
      const secretNames = new Set(cols.map((r) => String(r.relname).toLowerCase()))
      for (let i = 0; i < statements.length; i++) {
        const renamed = checkWriteScope(statements[i], { secretRelations: secretNames })
        if (renamed) throw refuse(i, renamed)
        if (!EXPLAINABLE.has(leadingKeyword(statements[i]))) continue
        let plan
        try {
          plan = (await client.query(`EXPLAIN (VERBOSE, FORMAT JSON) ${statements[i]}`)).rows[0]?.['QUERY PLAN']
        } catch (pgErr) {
          throw Object.assign(new Error('statement'), { __result: statementError(pgErr, i, true) })
        }
        const used = checkPlanSecrets(plan, { secretRelations })
        if (used) throw refuse(i, used)
      }
      return new Set(cols.map((r) => `${r.oid}/${r.attnum}`))
    }
    const runAll = async (client, secretColumns = null) => {
      for (let i = 0; i < statements.length; i++) {
        let stmt = statements[i]
        if (i === lastIdx && shouldAutoLimit(stmt)) stmt = `${stmt}\nLIMIT ${DEFAULT_ROW_CAP + 1}`
        let res
        try {
          res = await client.query({ text: stmt, types: queryTypes })
        } catch (pgErr) {
          throw Object.assign(new Error('statement'), { __result: statementError(pgErr, i, writeMode) })
        }
        if (i === lastIdx) {
          // a multi-statement string answers an array; the last one is the one shown
          const r = Array.isArray(res) ? res[res.length - 1] : res
          const fields = r?.fields || []
          if (fields.length) {
            // write mode: a secret column never comes back, however it was
            // selected (SELECT *, t.*, RETURNING *, a CTE's column): by its
            // name or by the table column it comes from (SEC-40)
            const secret = (f) => SECRET_COLUMN_RE.test(String(f.name).toLowerCase()) ||
              (secretColumns != null && f.tableID > 0 && secretColumns.has(`${f.tableID}/${f.columnID}`))
            const shown = writeMode ? fields.filter((f) => !secret(f)) : fields
            const hidden = writeMode ? fields.filter(secret).map((f) => f.name) : []
            const all = r.rows || []
            const names = shown.map((f) => f.name)
            const rows = all.slice(0, DEFAULT_ROW_CAP).map((row) => names.map((n) => row[n] ?? null))
            out = {
              columns: names, rows, row_count: all.length > DEFAULT_ROW_CAP ? DEFAULT_ROW_CAP : all.length, truncated: all.length > DEFAULT_ROW_CAP,
              ...(hidden.length ? { hidden_columns: hidden } : {})
            }
          } else {
            out = { columns: ['command', 'rowCount'], rows: [[r?.command ?? 'OK', r?.rowCount ?? 0]], row_count: 1, truncated: false, affected: r?.rowCount ?? 0 }
          }
        }
      }
    }
    const auditEntry = (result) => ({
      actorId,
      action: writeMode ? 'sql.write' : 'sql.read',
      details: {
        sql: maskSql(sqlText),
        sql_sha256: createHash('sha256').update(sqlText, 'utf8').digest('hex'),
        statements: statements.length,
        rows: result.row_count,
        ...(writeMode ? { committed: commit } : {}),
        ...(Number.isFinite(result.affected) ? { affected: result.affected } : {})
      }
    })

    try {
      await withClient(async (client) => {
        if (!writeMode) {
          await asReader(client, () => runAll(client))
          return
        }
        await client.query('BEGIN')
        try {
          await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
          await client.query('SET LOCAL search_path = public, pg_catalog')
          await client.query("SELECT set_config('ov.user_id', $1, true), set_config('ov.admin', 'on', true)", [actorId])
          const secretColumns = await guardSecrets(client)
          await runAll(client, secretColumns)
          if (commit) {
            await audit(client, auditEntry(out))
            await client.query('COMMIT')
          } else {
            await client.query('ROLLBACK')
          }
        } catch (err) {
          try { await client.query('ROLLBACK') } catch { /* connection already gone */ }
          throw err
        }
      })
    } catch (err) {
      if (err?.__result) {
        log.warn?.(`[sql] ${writeMode ? (commit ? 'write' : 'preview') : 'read'} refused by the database: ${err.__result.body?.error?.code}`)
        return err.__result
      }
      log.error?.(`[sql] run failed: ${err?.code || ''} ${String(err?.message || err).slice(0, 200)}`)
      if (err?.code === '42704') return fail(503, 'OV_SQL_READER_MISSING', 'The reader role is missing: run apply-roles.sh < roles.sql on the server.')
      return unavailable()
    }
    // a read or a preview: audited after the rollback (nothing else was written)
    if (!commit) {
      try { await audit(pool, auditEntry(out)) } catch (err) { log.warn?.(`[sql] audit failed: ${err?.code || err?.message}`) }
    } else {
      schemaCache = null
    }
    return ok({ ...out, duration_ms: Date.now() - started, statements: statements.length, write_mode: writeMode, committed: commit })
  }

  return { schema, run }
}
