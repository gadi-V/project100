/**
 * Tiered production env checks.
 *
 * P0 (database + Upstash) hard-fail at process start so auth and booking
 * rate limits are not missing Redis. If Redis throws at request time, every
 * limiter fails open (lib/security/rate-limit.ts). Missing credentials in
 * production still fail closed for auth and booking. P1 integrations warn
 * and stay disabled so public pages still load.
 * Values are never returned or logged.
 */

export const P0_ENV_KEYS = ["DATABASE_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;

/**
 * Keys the running clients actually read. A service is present only when every
 * key it needs is set. Supabase also accepts `SUPABASE_SERVICE_KEY` in place of
 * `SUPABASE_SERVICE_ROLE_KEY` (`lib/storage.ts`).
 */
export const P1_ENV_CHECKS = [
  {
    service: "stripe",
    subsystem: "Payments",
    keys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  {
    service: "whatsapp",
    subsystem: "Chat",
    keys: ["WHATSAPP_API_URL", "WHATSAPP_API_KEY"],
  },
  {
    service: "supabase",
    subsystem: "Storage",
    keys: ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  },
  {
    service: "twilio",
    subsystem: "SMS/Recovery",
    keys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
  },
  {
    service: "google",
    subsystem: "Auth",
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  },
] as const;

export type P1EnvCheck = (typeof P1_ENV_CHECKS)[number];
export type OptionalServiceId = P1EnvCheck["service"];
export type ServiceId = "database" | "redis" | OptionalServiceId;

function isSet(key: string): boolean {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/** Production server boot. Skipped for local/test and for `next build`, which often has no secrets. */
export function isProductionRuntime(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  return true;
}

export function missingP0Keys(): string[] {
  return P0_ENV_KEYS.filter((key) => !isSet(key));
}

export function missingP0ServiceIds(): Array<"database" | "redis"> {
  const missing: Array<"database" | "redis"> = [];
  if (!isSet("DATABASE_URL")) missing.push("database");
  if (!isSet("UPSTASH_REDIS_REST_URL") || !isSet("UPSTASH_REDIS_REST_TOKEN")) missing.push("redis");
  return missing;
}

/** True when this integration's client can make a real call. */
export function isP1CheckSatisfied(check: P1EnvCheck): boolean {
  if (check.service === "supabase") {
    return isSet("SUPABASE_URL") && (isSet("SUPABASE_SERVICE_ROLE_KEY") || isSet("SUPABASE_SERVICE_KEY"));
  }
  return check.keys.every((key) => isSet(key));
}

/** Key names to print when the service is off. Values are never included. */
export function missingKeysForP1Check(check: P1EnvCheck): string[] {
  if (check.service === "supabase") {
    const missing: string[] = [];
    if (!isSet("SUPABASE_URL")) missing.push("SUPABASE_URL");
    if (!isSet("SUPABASE_SERVICE_ROLE_KEY") && !isSet("SUPABASE_SERVICE_KEY")) {
      missing.push("SUPABASE_SERVICE_ROLE_KEY");
    }
    return missing;
  }
  return check.keys.filter((key) => !isSet(key));
}

export function missingServiceIds(): ServiceId[] {
  const missing: ServiceId[] = [...missingP0ServiceIds()];
  for (const check of P1_ENV_CHECKS) {
    if (!isP1CheckSatisfied(check)) missing.push(check.service);
  }
  return missing;
}

/**
 * Fatal when a P0 variable is absent in production. The message lists key names only.
 */
export function assertProductionEnv(): void {
  if (!isProductionRuntime()) return;
  const missing = missingP0Keys();
  if (missing.length === 0) return;
  throw new Error(
    `[env] FATAL: refusing to start in production. Missing required variables: ${missing.join(", ")}. ` +
      "DATABASE_URL and Upstash Redis must be set so the database is reachable and auth/booking rate limits can run."
  );
}

/** Soft-fail: log each disabled subsystem. Does not throw. */
export function warnDisabledSubsystems(): void {
  if (!isProductionRuntime()) return;
  for (const check of P1_ENV_CHECKS) {
    const missing = missingKeysForP1Check(check);
    if (missing.length === 0) continue;
    const verb = missing.length === 1 ? "is" : "are";
    console.warn(`[env] ${check.subsystem} is disabled (${missing.join(", ")} ${verb} not set)`);
  }
}
