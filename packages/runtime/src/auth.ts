import crypto from 'node:crypto';

/**
 * Constant-time bearer check shared by HTTP routes and the event stream.
 *
 * Accepts only `Bearer <token>` with an exact match. Length mismatches
 * fail before the timing-safe compare, which needs equal-size buffers.
 */
export function checkBearer(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  const given = Buffer.from(parts[1] ?? '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length === 0 || given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}
