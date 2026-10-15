/**
 * Distributed sliding-window rate limiting backed by Upstash Redis (REST).
 * Stateless per instance — safe for serverless / edge middleware.
 *
 * Circuit breaker when Upstash cannot answer (tokens missing, or Redis throws):
 *
 * - `auth` and `booking` FAIL CLOSED in production. Login, registration,
 *   password reset, and lesson booking are abuse-sensitive. If the limiter
 *   cannot run, the request is rejected (the middleware returns 503) instead
 *   of being served with no limit.
 * - `api` (public form posts such as leads) FAILS OPEN. The request proceeds,
 *   the result is flagged `degraded`, and a throttled error is logged.
 *   Static reads are not sent through this limiter at all.
 * - Outside production, missing Redis bypasses the limiter so local dev works
 *   without Upstash. A runtime Redis error outside production also fails open.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitType = "auth" | "booking" | "api";

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix epoch (ms) when the current window resets. */
  reset: number;
  /** True when no limiter ran (exempt path, or Redis unset outside production). */
  bypassed: boolean;
  /**
   * True when the limiter should have run but could not.
   * Combined with `success: false` this is fail-closed (auth/booking in production).
   * Combined with `success: true` this is fail-open (public posts, or any type outside production).
   */
  degraded: boolean;
};

/**
 * `auth` is sized for a classroom logging in together from one school NAT IP;
 * the key is per path + IP, so each auth endpoint has its own budget.
 * `booking` is stricter: each POST creates a lesson or moves one.
 */
export const RATE_LIMITS: Record<RateLimitType, { requests: number; window: `${number} s` }> = {
  auth: { requests: 15, window: "60 s" },
  booking: { requests: 10, window: "60 s" },
  api: { requests: 30, window: "60 s" },
};

/** Abuse-sensitive types. Production outages of Redis reject these. */
const FAIL_CLOSED_TYPES = new Set<RateLimitType>(["auth", "booking"]);

const RATE_LIMIT_EXEMPT_PREFIXES = ["/api/cron/"] as const;

/**
 * Upper bound on added latency per request.
 * The Upstash SDK treats its own timeout as an allow (client-side fail open).
 * A thrown Redis error still hits the circuit breaker in `checkRateLimit`.
 */
const REDIS_TIMEOUT_MS = 2000;

/** Degraded-mode errors are re-logged at most this often per instance (log-based alerting). */
export const DEGRADED_ALERT_INTERVAL_MS = 60_000;

let limiters: { key: string; byType: Record<RateLimitType, Ratelimit> } | null = null;
let warnedMissingConfig = false;
let lastDegradedAlertAt = Number.NEGATIVE_INFINITY;

function alertDegraded(message: string, error?: unknown): void {
  const now = Date.now();
  if (now - lastDegradedAlertAt < DEGRADED_ALERT_INTERVAL_MS) return;
  lastDegradedAlertAt = now;
  if (error === undefined) console.error(message);
  else console.error(message, error);
}

export function isRateLimitExempt(pathname: string): boolean {
  return RATE_LIMIT_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/** First hop of `x-forwarded-for`, then `x-real-ip`, else `"unknown"`. */
export function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function failsClosed(type: RateLimitType): boolean {
  return process.env.NODE_ENV === "production" && FAIL_CLOSED_TYPES.has(type);
}

function getLimiters(): Record<RateLimitType, Ratelimit> | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;

  const key = `${url}|${token}`;
  if (limiters?.key !== key) {
    const redis = new Redis({ url, token });
    const build = (type: RateLimitType) =>
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(RATE_LIMITS[type].requests, RATE_LIMITS[type].window),
        prefix: `project8:ratelimit:${type}`,
        timeout: REDIS_TIMEOUT_MS,
        analytics: false,
      });
    limiters = {
      key,
      byType: { auth: build("auth"), booking: build("booking"), api: build("api") },
    };
  }
  return limiters.byType;
}

function passThrough(type: RateLimitType): RateLimitResult {
  const { requests } = RATE_LIMITS[type];
  return {
    success: true,
    limit: requests,
    remaining: requests,
    reset: Date.now(),
    bypassed: true,
    degraded: false,
  };
}

/** Limiter unavailable. Auth/booking in production are rejected; everything else proceeds. */
function degradedResult(type: RateLimitType): RateLimitResult {
  if (!failsClosed(type)) {
    return { ...passThrough(type), degraded: true };
  }
  const { requests } = RATE_LIMITS[type];
  return {
    success: false,
    limit: requests,
    remaining: 0,
    reset: Date.now() + 60_000,
    bypassed: false,
    degraded: true,
  };
}

export async function checkRateLimit(
  req: Request,
  type: RateLimitType = "api"
): Promise<RateLimitResult> {
  const pathname = new URL(req.url).pathname;
  if (isRateLimitExempt(pathname)) return passThrough(type);

  const byType = getLimiters();
  if (!byType) {
    if (process.env.NODE_ENV === "production") {
      const mode = failsClosed(type) ? "failing closed" : "failing open";
      alertDegraded(
        `[rate-limit] DEGRADED: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set in production — ${mode} for ${type}`
      );
      return degradedResult(type);
    }
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      console.warn(
        "[rate-limit] Upstash Redis env not set — rate limiting is bypassed outside production"
      );
    }
    return passThrough(type);
  }

  const identifier = `${pathname}:${getClientIp(req)}`;
  try {
    const { success, limit, remaining, reset } = await byType[type].limit(identifier);
    return { success, limit, remaining, reset, bypassed: false, degraded: false };
  } catch (error) {
    const mode = failsClosed(type) ? "failing closed" : "failing open";
    alertDegraded(`[rate-limit] DEGRADED: Upstash Redis error — ${mode} for ${type}:`, error);
    return degradedResult(type);
  }
}
