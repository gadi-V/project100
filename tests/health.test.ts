import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: { $queryRaw: db.queryRaw },
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /api/health", () => {
  it("returns 200 UP when the database answers SELECT 1", async () => {
    db.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ status: "UP", database: "UP" });
    expect(db.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns 503 DOWN without leaking driver details when the database is unreachable", async () => {
    db.queryRaw.mockRejectedValue(new Error("connect ECONNREFUSED postgresql://user:secret@host/db"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { GET } = await import("../app/api/health/route");

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.data).toMatchObject({ status: "DOWN", database: "DOWN" });
    expect(JSON.stringify(body)).not.toContain("secret");
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
