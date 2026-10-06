// Pure helpers for verify.mjs. No network, no process state: unit-tested by lib.test.mjs.
import { createHash } from 'node:crypto';

/** Parses a dotenv-style file: KEY=VALUE, `#` comments, optional single or double quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`config line is not KEY=VALUE: ${line.slice(0, 40)}`);
    let value = match[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[match[1]] = value;
  }
  return out;
}

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function parseTomlScalar(text) {
  const value = text.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(value)) return Number(value.replace(/_/g, ''));
  return value;
}

function splitTomlArray(body) {
  const items = [];
  let quote = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"') {
        current += body[i + 1] ?? '';
        i += 1;
      } else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ',') {
      if (current.trim()) items.push(current);
      current = '';
    } else current += c;
  }
  if (current.trim()) items.push(current);
  return items.map(parseTomlScalar);
}

/**
 * Reads the subset of TOML the Paykit and Locks configs use (tables, dotted tables, strings,
 * booleans, numbers, string arrays) into a flat `table.key -> value` map. Inline tables are kept
 * as raw text. Callers read only named non-secret keys from the result.
 */
export function parseTomlFlat(text) {
  const out = {};
  let table = '';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripTomlComment(lines[i]).trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([A-Za-z0-9_.-]+)\s*\]$/);
    if (header) {
      table = header[1];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[')) {
      while (!/\]\s*$/.test(value) && i + 1 < lines.length) {
        i += 1;
        value += ' ' + stripTomlComment(lines[i]).trim();
      }
      out[table ? `${table}.${kv[1]}` : kv[1]] = splitTomlArray(value.trim().slice(1, -1));
    } else {
      out[table ? `${table}.${kv[1]}` : kv[1]] = parseTomlScalar(value);
    }
  }
  return out;
}

/** Splits a list given as a JSON array, a TOML array, or comma/space separated text. */
export function parseList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null) return [];
  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return splitTomlArray(text.slice(1, -1)).map(String);
    }
  }
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lower-cased scheme://host[:port] with default ports removed, or null for a non-URL. */
export function normalizeOrigin(value) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** A base URL without trailing slashes, for equality between configured and published URLs. */
export function normalizeBase(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    return `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(value).trim().replace(/\/+$/, '');
  }
}

/** Origins in `required` that `allowed` does not list. A `*` entry is reported separately by callers. */
export function missingOrigins(allowed, required) {
  const have = new Set(parseList(allowed).map(normalizeOrigin).filter(Boolean));
  return parseList(required)
    .map(normalizeOrigin)
    .filter((origin) => origin && !have.has(origin));
}

/**
 * JSON.parse that tolerates raw control characters inside strings (Nexus serves listing
 * descriptions with unescaped newlines and tabs), like Python's json.loads(strict=False).
 */
export function parseJsonLenient(text) {
  try {
    return JSON.parse(text);
  } catch {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (inString) {
        if (c === '\\') {
          out += c + (text[i + 1] ?? '');
          i += 1;
          continue;
        }
        if (c === '"') inString = false;
        const code = c.charCodeAt(0);
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : c;
      } else {
        if (c === '"') inString = true;
        out += c;
      }
    }
    return JSON.parse(out);
  }
}

/** Extracts the Shop's `window.__PUBKY_CONFIG__ = Object.freeze({...})` runtime config from page HTML. */
export function extractRuntimeConfig(html) {
  const start = html.indexOf('__PUBKY_CONFIG__=Object.freeze(');
  if (start < 0) return null;
  const open = html.indexOf('{', start);
  let depth = 0;
  let quote = false;
  for (let i = open; i < html.length; i += 1) {
    const c = html[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(open, i + 1));
    }
  }
  return null;
}

/** sqlx records SHA-384 of the migration file bytes; `.down.sql` files are never applied. */
export function expectedMigration(fileName, bytes) {
  const match = fileName.match(/^(\d+)_.+?(\.up)?\.sql$/);
  if (!match || fileName.endsWith('.down.sql')) return null;
  return {
    version: Number(match[1]),
    file: fileName,
    checksum: createHash('sha384').update(bytes).digest('hex'),
  };
}

/** Parses `MIV|<version>|<success>|<checksum-hex>` rows printed by the migration query. */
export function parseMigrationRows(stdout) {
  const rows = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = line.trim().match(/^MIV\|(\d+)\|(t|f|true|false)\|([0-9a-f]*)$/);
    if (match) rows.push({ version: Number(match[1]), success: match[2].startsWith('t'), checksum: match[3] });
  }
  return rows;
}

/** Compares the applied ledger with the source's migration set. */
export function compareMigrations(expected, applied) {
  const byVersion = new Map(applied.map((row) => [row.version, row]));
  const expectedVersions = new Set(expected.map((m) => m.version));
  const missing = [];
  const mismatched = [];
  const failed = [];
  for (const migration of expected) {
    const row = byVersion.get(migration.version);
    if (!row) missing.push(migration.version);
    else if (!row.success) failed.push(migration.version);
    else if (row.checksum !== migration.checksum) mismatched.push(migration.version);
  }
  const extra = applied.filter((row) => !expectedVersions.has(row.version)).map((row) => row.version);
  return { missing, mismatched, failed, extra, ok: !missing.length && !mismatched.length && !failed.length && !extra.length };
}

/** `owner/repo@ref` (GitHub) into its parts; the ref may be a branch, tag or commit SHA. */
export function parseSourceRef(value) {
  const match = String(value ?? '').match(/^([\w.-]+)\/([\w.-]+)@([\w./-]+)$/);
  return match ? { owner: match[1], repo: match[2], ref: match[3] } : null;
}

/** Splits `registry/name[:tag][@sha256:digest]` into registry, repository and reference. */
export function parseImageRef(ref) {
  const at = ref.indexOf('@');
  let name = at >= 0 ? ref.slice(0, at) : ref;
  let reference = at >= 0 ? ref.slice(at + 1) : null;
  const slash = name.indexOf('/');
  const first = slash >= 0 ? name.slice(0, slash) : '';
  let registry = 'registry-1.docker.io';
  if (slash >= 0 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    name = name.slice(slash + 1);
  } else if (slash < 0) {
    name = `library/${name}`;
  }
  const colon = name.lastIndexOf(':');
  if (colon > 0) {
    if (!reference) reference = name.slice(colon + 1);
    name = name.slice(0, colon);
  }
  return { registry, repository: name, reference: reference ?? 'latest' };
}

/** Parses a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge. */
export function parseBearerChallenge(header) {
  if (!header || !/^bearer\s/i.test(header)) return null;
  const params = {};
  for (const match of header.matchAll(/(\w+)="([^"]*)"/g)) params[match[1]] = match[2];
  return params.realm ? params : null;
}

/** First 12 characters of a key or hash, for output that must not reproduce full identifiers. */
export function short(value) {
  const text = String(value ?? '');
  return text.length > 14 ? `${text.slice(0, 12)}…` : text;
}

const SECRETISH = /(postgres(ql)?|redis|mysql|amqp):\/\/[^\s"']+|bearer\s+[^\s"']+|(secret|password|token|key)=([^&\s"']+)/gi;

/** Scrubs connection strings, bearer tokens and `secret=` style parameters from text before output. */
export function redact(text) {
  return String(text ?? '').replace(SECRETISH, (match) => {
    const scheme = match.match(/^(\w+):\/\//);
    if (scheme) return `${scheme[1]}://[redacted]`;
    if (/^bearer/i.test(match)) return 'Bearer [redacted]';
    return match.replace(/=.*/, '=[redacted]');
  });
}
