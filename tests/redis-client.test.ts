import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  ping: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    ping() {
      return api.ping();
    }
    set(...args: unknown[]) {
      return api.set(...args);
    }
    get(...args: unknown[]) {
      return api.get(...args);
    }
    del(...args: unknown[]) {
      return api.del(...args);
    }
  },
}));

async function loadRedis() {
  return import("../lib/redis");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  api.ping.mockReset();
  api.set.mockReset();
  api.get.mockReset();
  api.del.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Upstash Redis client", () => {
  it("does not call Redis when the REST credentials are missing", async () => {
    const { pingRedis, getRedis } = await loadRedis();

    expect(getRedis()).toBeNull();
    await expect(pingRedis()).resolves.toEqual({ ok: false, latencyMs: 0 });
    expect(api.ping).not.toHaveBeenCalled();
  });

  it("pings, writes, reads, and deletes through the shared client", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unified-arachnid.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    api.ping.mockResolvedValue("PONG");
    api.set.mockResolvedValue("OK");
    api.get.mockResolvedValue("1");
    api.del.mockResolvedValue(1);
    const { getRedis, pingRedis } = await loadRedis();

    const redis = getRedis();
    expect(redis).not.toBeNull();
    const ping = await pingRedis();
    expect(ping.ok).toBe(true);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);

    await redis!.set("project100:smoke", "1", { ex: 30 });
    await expect(redis!.get("project100:smoke")).resolves.toBe("1");
    await redis!.del("project100:smoke");

    expect(api.set).toHaveBeenCalledWith("project100:smoke", "1", { ex: 30 });
    expect(api.get).toHaveBeenCalledWith("project100:smoke");
    expect(api.del).toHaveBeenCalledWith("project100:smoke");
    expect(getRedis()).toBe(redis);
  });

  it("reports a failed ping without throwing", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://unified-arachnid.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-token");
    api.ping.mockRejectedValue(new Error("ECONNRESET"));
    const { pingRedis } = await loadRedis();

    const ping = await pingRedis();
    expect(ping.ok).toBe(false);
    expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
