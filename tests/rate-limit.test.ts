import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type LimitResponse = { success: boolean; limit: number; remaining: number; reset: number };

const rl = vi.hoisted(() => ({
  /** Receives (prefix, identifier) so tests can tell the auth and api limiters apart. */
  limit: vi.fn<(prefix: string, identifier: string) => Promise<LimitResponse>>(),
}));

vi.mock("@upstash/ratelimit", () => {
  class Ratelimit {
    static slidingWindow = (requests: number, window: string) => ({ requests, window });
    private readonly prefix: string;
    constructor(options: { prefix: string }) {
      this.prefix = options.prefix;
    }
    limit(identifier: string) {
      return rl.limit(this.prefix, identifier);
    }
  }
  return { Ratelimit };
});

const ORIGIN = "https://project100.vercel.app";

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers });
}

function configureRedis() {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://fake-redis.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
}

async function loadRateLimit() {
  return import("../lib/security/rate-limit");
}

async function loadMiddleware() {
  return (await import("../middleware")).middleware;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  rl.limit.mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: Date.now() + 60_000 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rl.limit.mockReset();
});

describe("fail-open without Redis outside production", () => {
  it("allows the request without error and warns only once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { checkRateLimit } = await loadRateLimit();

    const first = await checkRateLimit(request("/api/login"), "auth");
    const second = await checkRateLimit(request("/api/leads"), "api");

    expect(first).toMatchObject({ success: true, bypassed: true, unavailable: false });
    expect(second.success).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rl.limit).not.toHaveBeenCalled();
  });

  it("lets auth routes through the middleware", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const middleware = await loadMiddleware();

    const res = await middleware(request("/api/login"));

    expect(res.status).not.toBe(429);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("fails closed with 503 in production when Redis is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { checkRateLimit } = await loadRateLimit();
    const middleware = await loadMiddleware();

    const result = await checkRateLimit(request("/api/login"), "auth");
    const res = await middleware(request("/api/login"));

    expect(result).toMatchObject({ success: false, unavailable: true });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("UPSTASH_REDIS_REST_URL"));
  });
});

describe("client IP extraction", () => {
  it.each([
    [{ "x-forwarded-for": "203.0.113.7" }, "203.0.113.7"],
    [{ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }, "203.0.113.7"],
    [{ "x-forwarded-for": "  198.51.100.4 ,10.0.0.1" }, "198.51.100.4"],
    [{ "x-forwarded-for": "2001:db8::1, 10.0.0.1" }, "2001:db8::1"],
    [{ "x-forwarded-for": "203.0.113.7", "x-real-ip": "10.9.9.9" }, "203.0.113.7"],
    [{ "x-real-ip": "192.0.2.10" }, "192.0.2.10"],
    [{ "x-forwarded-for": " , ", "x-real-ip": "192.0.2.10" }, "192.0.2.10"],
    [{}, "unknown"],
  ])("%j → %s", async (headers, expected) => {
    const { getClientIp } = await loadRateLimit();
    expect(getClientIp(request("/api/login", headers))).toBe(expected);
  });

  it("keys the Redis limiter by path and the first forwarded IP", async () => {
    configureRedis();
    const { checkRateLimit } = await loadRateLimit();

    await checkRateLimit(
      request("/api/login", { "x-forwarded-for": "203.0.113.7, 10.0.0.1" }),
      "auth"
    );

    expect(rl.limit).toHaveBeenCalledWith("project8:ratelimit:auth", "/api/login:203.0.113.7");
  });
});

describe("/api/cron/* exemption", () => {
  it.each(["/api/cron/reminders", "/api/cron/head-of-desk", "/api/cron/some-future-job"])(
    "checkRateLimit never consults Redis for %s",
    async (path) => {
      configureRedis();
      rl.limit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60_000 });
      const { checkRateLimit } = await loadRateLimit();

      const auth = await checkRateLimit(request(path), "auth");
      const api = await checkRateLimit(request(path), "api");

      expect(auth).toMatchObject({ success: true, bypassed: true });
      expect(api).toMatchObject({ success: true, bypassed: true });
      expect(rl.limit).not.toHaveBeenCalled();
    }
  );

  it("middleware passes cron routes through even when every limiter would deny", async () => {
    configureRedis();
    rl.limit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 60_000 });
    const middleware = await loadMiddleware();

    for (let i = 0; i < 10; i++) {
      const res = await middleware(
        request("/api/cron/reminders", { authorization: "Bearer from-scheduler" })
      );
      expect(res.status).not.toBe(429);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
    expect(rl.limit).not.toHaveBeenCalled();
  });

  it("does not exempt look-alike paths", async () => {
    const { isRateLimitExempt } = await loadRateLimit();
    expect(isRateLimitExempt("/api/cron/reminders")).toBe(true);
    expect(isRateLimitExempt("/api/cronjobs")).toBe(false);
    expect(isRateLimitExempt("/api/cron")).toBe(false);
    expect(isRateLimitExempt("/api/login")).toBe(false);
  });
});

describe("middleware with Redis configured", () => {
  it("returns 429 JSON with Retry-After when the auth limit is exceeded", async () => {
    configureRedis();
    rl.limit.mockResolvedValue({ success: false, limit: 5, remaining: 0, reset: Date.now() + 30_000 });
    const middleware = await loadMiddleware();

    const res = await middleware(request("/api/login", { "x-forwarded-for": "203.0.113.7" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too Many Requests" });
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
  });

  it.each([
    ["/api/login", "project8:ratelimit:auth"],
    ["/api/register", "project8:ratelimit:auth"],
    ["/api/auth/forgot-password", "project8:ratelimit:auth"],
    ["/api/auth/reset-password", "project8:ratelimit:auth"],
    ["/api/leads", "project8:ratelimit:api"],
  ])("applies the right limiter to %s", async (path, prefix) => {
    configureRedis();
    const middleware = await loadMiddleware();

    await middleware(request(path));

    expect(rl.limit).toHaveBeenCalledTimes(1);
    expect(rl.limit).toHaveBeenCalledWith(prefix, expect.stringContaining(path));
  });

  it("does not rate limit other routes", async () => {
    configureRedis();
    const middleware = await loadMiddleware();

    await middleware(request("/api/lessons"));
    await middleware(request("/dashboard"));

    expect(rl.limit).not.toHaveBeenCalled();
  });

  it("fails open (and logs) when Redis errors at runtime", async () => {
    configureRedis();
    rl.limit.mockRejectedValue(new Error("ECONNRESET"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const middleware = await loadMiddleware();

    const res = await middleware(request("/api/login"));

    expect(res.status).not.toBe(429);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("Upstash Redis error"),
      expect.any(Error)
    );
  });
});
