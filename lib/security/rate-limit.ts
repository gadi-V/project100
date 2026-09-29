/**
 * Distributed sliding-window rate limiting backed by Upstash Redis (REST).
 * Stateless per instance — safe for serverless / edge middleware.
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

export type RateLimitType = "auth" | "api";

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix epoch (ms) when the current window resets. */
  reset: number;
  /** True when no limiter ran (exempt path, Redis unset, or Redis error). */
  bypassed: boolean;
  /** True when the limiter should have run but could not (fail-open in production or Redis error). */
  degraded: boolean;
};

/**
 * `auth` is sized for a classroom logging in together from one school NAT IP;
 * the key is per path + IP, so each auth endpoint has its own budget.
 */
export const RATE_LIMITS: Record<RateLimitType, { requests: number; window: `${number} s` }> = {
  auth: { requests: 15, window: "60 s" },
  api: { requests: 30, window: "60 s" },
};

const RATE_LIMIT_EXEMPT_PREFIXES = ["/api/cron/"] as const;

/** Upper bound on added latency per request; Upstash allows the request on timeout. */
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
    limiters = { key, byType: { auth: build("auth"), api: build("api") } };
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

export async function checkRateLimit(
  req: Request,
  type: RateLimitType = "api"
): Promise<RateLimitResult> {
  const pathname = new URL(req.url).pathname;
  if (isRateLimitExempt(pathname)) return passThrough(type);

  const byType = getLimiters();
  if (!byType) {
    if (process.env.NODE_ENV === "production") {
      alertDegraded(
        "[rate-limit] DEGRADED: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set in production — failing open (requests are NOT rate limited)"
      );
      return { ...passThrough(type), degraded: true };
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
    alertDegraded("[rate-limit] DEGRADED: Upstash Redis error — failing open:", error);
    return { ...passThrough(type), degraded: true };
  }
}
