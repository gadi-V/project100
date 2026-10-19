import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { P0_ENV_KEYS, P1_ENV_CHECKS } from "../lib/env-validator";

const probes = vi.hoisted(() => ({
  pingRedis: vi.fn(),
  probeStream: vi.fn(),
  probeStorage: vi.fn(),
}));

vi.mock("../lib/redis", () => ({
  pingRedis: probes.pingRedis,
}));

vi.mock("../lib/stream-health", () => ({
  probeStreamAvailability: probes.probeStream,
}));

vi.mock("../lib/storage", () => ({
  probeLessonBoardsStorage: probes.probeStorage,
}));

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

beforeEach(() => {
  probes.pingRedis.mockResolvedValue({ ok: true, latencyMs: 4 });
  probes.probeStream.mockResolvedValue({ status: "up", latencyMs: 6 });
  probes.probeStorage.mockResolvedValue({ status: "up", latencyMs: 7 });
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
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      latency: { db: expect.stringMatching(/^\d+ms$/) },
      missing_services: [],
      services: {
        database: { status: "up", latencyMs: expect.any(Number) },
        redis: { status: "up", latencyMs: 4 },
        stream: { status: "up", latencyMs: 6 },
        storage: { status: "up", latencyMs: 7 },
      },
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
    expect(body.services.redis.status).toBe("up");
    expect(body.services.stream.status).toBe("up");
    expect(body.services.storage.status).toBe("up");
    expect(body.missing_services).not.toContain("supabase");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
    expect(body.services.database.status).toBe("down");
    expect(body.services.redis.status).toBe("up");
    expect(db.queryRaw).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("returns 200 degraded when Redis or Stream is down and does not throw", async () => {
    stubAllConfigured();
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    probes.pingRedis.mockResolvedValue({ ok: false, latencyMs: 12 });
    probes.probeStream.mockRejectedValue(new Error("stream boom token=secret"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.services.database.status).toBe("up");
    expect(body.services.redis).toEqual({ status: "down", latencyMs: 12 });
    expect(body.services.stream).toEqual({ status: "down", latencyMs: null });
    expect(body.services.storage).toEqual({ status: "up", latencyMs: 7 });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("stream boom");
  });

  it("reports storage down with latency and keeps supabase out of missing_services when keys are set", async () => {
    stubAllConfigured();
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    probes.probeStorage.mockResolvedValue({ status: "down", latencyMs: 21 });
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.missing_services).not.toContain("supabase");
    expect(body.services.storage).toEqual({ status: "down", latencyMs: 21 });
  });

  it("lists supabase as missing and storage as down when the probe throws", async () => {
    stubAllConfigured();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    probes.probeStorage.mockRejectedValue(new Error("storage boom key=secret"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.missing_services).toContain("supabase");
    expect(body.services.storage).toEqual({ status: "down", latencyMs: null });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("is public in the proxy (no session required) and is not rewritten on the teachers host", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const { proxy } = await import("../proxy");

    const local = await proxy(new NextRequest("http://localhost/api/health"));
    expect(local.status).not.toBe(401);
    expect(local.headers.get("x-middleware-next")).toBe("1");
    expect(local.headers.get("x-middleware-rewrite")).toBeNull();

    const teachers = await proxy(
      new NextRequest("https://teachers.project100.co.il/api/health", {
        headers: { host: "teachers.project100.co.il" },
      })
    );
    expect(teachers.headers.get("x-middleware-next")).toBe("1");
    expect(teachers.headers.get("x-middleware-rewrite")).toBeNull();
    expect(teachers.headers.get("location")).toBeNull();
  });
});
