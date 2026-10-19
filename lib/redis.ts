/**
 * Upstash Redis REST client (Frankfurt in production).
 * One client per process, rebuilt when the URL or token changes.
 * Callers must not log the token.
 */

import { Redis } from "@upstash/redis";

export type RedisPingResult = {
  ok: boolean;
  latencyMs: number;
};

let cached: { key: string; redis: Redis } | null = null;

export function redisRestConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  return { url, token };
}

export function getRedis(): Redis | null {
  const cfg = redisRestConfig();
  if (!cfg) return null;
  const key = `${cfg.url}|${cfg.token}`;
  if (cached?.key !== key) {
    cached = { key, redis: new Redis({ url: cfg.url, token: cfg.token }) };
  }
  return cached.redis;
}

/** `PING`. Never throws — a network miss is `ok: false`. */
export async function pingRedis(): Promise<RedisPingResult> {
  const redis = getRedis();
  const started = Date.now();
  if (!redis) return { ok: false, latencyMs: 0 };
  try {
    const pong = await redis.ping();
    return { ok: pong === "PONG", latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}
