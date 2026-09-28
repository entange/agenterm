/**
 * Secrets handling.
 *
 * Terminal logs plus harness logs plus a local daemon are sensitive when
 * handling slips. All ingested logs are treated as untrusted input. This
 * module offers the early simple mask used on display and on export.
 */

const SECRET_KEY_PATTERN = /(key|token|secret|password)/i;

/** Blocklist check for environment keys. Case-insensitive substring plus prefixes. */
export function isSecretEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SECRET_KEY_PATTERN.test(key)) return true;
  if (upper === 'DATABASE_URL') return true;
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

const REDACT_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9-_]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/=]{8,}/g
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
  for (const pattern of REDACT_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
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
