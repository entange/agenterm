/**
 * Secrets handling.
 *
 * Terminal logs plus harness logs plus a local daemon are sensitive when
 * handling slips. All ingested logs are treated as untrusted input. This
 * module offers the early simple mask used on display and on export.
 */

const SECRET_KEY_PATTERN = /(apikey|token|secret|password|passwd|credential)/i;

/** Name segments (split on `_`, `-`, `.`) that mark a secret on their own. */
const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  'KEY',
  'PASS',
  'PWD',
  'AUTH',
  'COOKIE',
  'DSN',
  'PRIVATE',
  'CREDENTIALS'
]);

/** Plain names that only look secret. */
const SAFE_KEYS: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'SSH_AUTH_SOCK', 'KEYCHAIN_PATH']);

/** Blocklist check for environment keys: secret words, secret name segments, and known prefixes. */
export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SAFE_KEYS.has(upper)) return false;
  if (SECRET_KEY_PATTERN.test(key)) return true;
  if (upper.split(/[_.-]/).some((segment) => SECRET_SEGMENTS.has(segment))) return true;
  if (upper === 'DATABASE_URL' || upper === 'REDIS_URL' || /^MONGO[A-Z_]*_URI$/.test(upper)) return true;
  if (upper.startsWith('AWS_')) return true;
  if (upper.startsWith('GH_')) return true;
  if (upper.startsWith('OPENAI_')) return true;
  if (upper.startsWith('ANTHROPIC_')) return true;
  return false;
}

/** Strip secrets-blocklist keys from an env map. Returns a fresh record. */
export function stripSecretEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretEnvKey(key)) {
      out[key] = value;
    }
  }
  return out;
}

const MASK = '[REDACTED]';

/** Token shapes, each anchored so ordinary words such as `task-manager` survive. */
const REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],
  [/(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/g, MASK],
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/(?<![A-Za-z0-9])npm_[A-Za-z0-9]{30,}/g, MASK],
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g, MASK],
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{8,}/g, MASK],
  [/(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // A credential has a digit or symbol in it, which keeps prose like "Bearer authentication" intact.
  [/\bBearer\s+(?=[A-Za-z0-9\-._~+/=]*[0-9\-._~+/=])[A-Za-z0-9\-._~+/=]{8,}/g, `Bearer ${MASK}`],
  [/\b(Authorization:\s*Basic)\s+[A-Za-z0-9+/=]{8,}/gi, `$1 ${MASK}`],
  // Credentials inside URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, `$1:${MASK}@`],
  // Assignments and JSON fields named like secrets: PASSWORD=..., "api_key": "..."
  [
    /\b([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*)(=|"\s*:\s*")(["']?)[^\s"'&]{4,}/gi,
    `$1$2$3${MASK}`
  ]
];

/**
 * Simple mask for display and export.
 *
 * Replaces known token shapes with [REDACTED]. Never throws: non-string
 * input yields an empty string. Export callers leave this default on.
 */
export function redactText(input: unknown): string {
  if (typeof input !== 'string') return '';
  let out = input;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact an env map for logging.
 *
 * Keeps key names, replaces secret values with [REDACTED]. Non-secret values
 * pass through unchanged. Used when logging resolved spawn env.
 */
export function redactEnvForLog(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretEnvKey(key) ? '[REDACTED]' : value;
  }
  return out;
}
