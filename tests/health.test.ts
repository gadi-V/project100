import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { P0_ENV_KEYS, P1_ENV_CHECKS } from "../lib/env-validator";

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { $queryRaw: db.queryRaw },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function stubPresent(key: string) {
  vi.stubEnv(key, `present-${key}`);
}

function stubAllConfigured() {
  for (const key of P0_ENV_KEYS) stubPresent(key);
  for (const check of P1_ENV_CHECKS) {
    for (const key of check.keys) stubPresent(key);
  }
}

describe("GET /api/health", () => {
  it("returns 200 healthy when the database answers and every service is configured", async () => {
    stubAllConfigured();
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      status: "healthy",
      latency: { db: expect.stringMatching(/^\d+ms$/) },
      missing_services: [],
    });
    expect(JSON.stringify(body)).not.toContain("present-");
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns 200 degraded and lists only the missing P1 services", async () => {
    stubAllConfigured();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "   ");
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.missing_services).toEqual(["stripe", "twilio"]);
    expect(body.latency.db).toMatch(/^\d+ms$/);
  });

  it("retries a refused cold start and recovers without surfacing the driver error", async () => {
    stubAllConfigured();
    db.queryRaw
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED postgresql://user:secret@host/db"))
      .mockResolvedValueOnce([{ "?column?": 1 }]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const { GET } = await import("../app/api/health/route");

    const pending = GET();
    await vi.advanceTimersByTimeAsync(1_000);
    const res = await pending;
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(db.queryRaw).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("postgresql");
  });

  it("returns 503 unhealthy after five failed pings and does not leak driver details", async () => {
    stubAllConfigured();
    db.queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED postgresql://user:secret@host/db"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();
    const { GET } = await import("../app/api/health/route");

    const pending = GET();
    await vi.advanceTimersByTimeAsync(4_000);
    const res = await pending;
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.missing_services).toEqual([]);
    expect(body.latency.db).toMatch(/^\d+ms$/);
    expect(db.queryRaw).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("is public in the proxy (no session required)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { proxy } = await import("../proxy");

    const res = await proxy(new NextRequest("http://localhost/api/health"));

    expect(res.status).not.toBe(401);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
