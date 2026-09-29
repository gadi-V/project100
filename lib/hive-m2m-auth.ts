/**
 * Edge-safe Hive M2M Bearer check (usable from middleware + Node routes).
 * Prefer Web Crypto timing-safe compare so this runs on the Edge runtime.
 */

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Constant-time compare of `Authorization: Bearer <token>` against
 * `HIVE_MONITOR_SECRET`. Returns false when unset/mismatched — never throws.
 */
export function isHiveMonitorBearer(request: Request): boolean {
  const secret = process.env.HIVE_MONITOR_SECRET?.trim();
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;

  return timingSafeEqualString(secret, token);
}
