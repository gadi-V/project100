import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SignJWT, base64url } from "jose";
import { verifyCronAuth, verifyCronRequest, verifyQStashSignature } from "../lib/auth/cron";
import { middleware } from "../middleware";

const ORIGIN = "https://project100.vercel.app";
const SIGNING_KEY = "sig_current_key";

function requestWith(
  headers: Record<string, string> = {},
  path = "/api/cron/reminders"
): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, { headers });
}

function requestWithBearer(token?: string, path = "/api/cron/reminders"): NextRequest {
  return requestWith(token === undefined ? {} : { authorization: `Bearer ${token}` }, path);
}

async function qstashSignature({
  key = SIGNING_KEY,
  path = "/api/cron/reminders",
  body = "",
  issuer = "Upstash",
}: { key?: string; path?: string; body?: string; issuer?: string } = {}): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return new SignJWT({ body: base64url.encode(new Uint8Array(digest)) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setSubject(`${ORIGIN}${path}`)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(key));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("verifyCronAuth", () => {
  it("accepts the CRON_SECRET bearer", () => {
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    expect(verifyCronAuth(requestWithBearer("vercel-secret"))).toBe(true);
  });

  it("rejects a wrong, empty, missing or non-Bearer credential", () => {
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    expect(verifyCronAuth(requestWithBearer("nope"))).toBe(false);
    expect(verifyCronAuth(requestWithBearer())).toBe(false);
    expect(verifyCronAuth(requestWithBearer(""))).toBe(false);
    expect(verifyCronAuth(requestWith({ authorization: "Basic vercel-secret" }))).toBe(false);
  });

  it("does not accept other M2M or legacy secrets", () => {
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    vi.stubEnv("HIVE_MONITOR_SECRET", "hive-secret");
    vi.stubEnv("CRON_API_KEY", "legacy-key");
    expect(verifyCronAuth(requestWithBearer("hive-secret"))).toBe(false);
    expect(verifyCronAuth(requestWithBearer("legacy-key"))).toBe(false);
  });

  it("fails closed and logs when CRON_SECRET is unset", () => {
    vi.stubEnv("CRON_SECRET", "");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(verifyCronAuth(requestWithBearer("anything"))).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CRON_SECRET"));
  });
});

describe("verifyQStashSignature", () => {
  it("accepts a valid signature for this route", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", SIGNING_KEY);
    const sig = await qstashSignature();
    expect(await verifyQStashSignature(requestWith({ "upstash-signature": sig }))).toBe(true);
  });

  it("accepts a signature made with the next key (rotation)", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "old_key");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", SIGNING_KEY);
    const sig = await qstashSignature();
    expect(await verifyQStashSignature(requestWith({ "upstash-signature": sig }))).toBe(true);
  });

  it("rejects a bare or forged upstash-signature header", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", SIGNING_KEY);
    expect(await verifyQStashSignature(requestWith({ "upstash-signature": "anything" }))).toBe(false);
    const forged = await qstashSignature({ key: "attacker_key" });
    expect(await verifyQStashSignature(requestWith({ "upstash-signature": forged }))).toBe(false);
  });

  it("rejects a signature issued for another route, body or issuer", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", SIGNING_KEY);
    for (const sig of [
      await qstashSignature({ path: "/api/cron/head-of-desk" }),
      await qstashSignature({ body: "{\"tampered\":true}" }),
      await qstashSignature({ issuer: "NotUpstash" }),
    ]) {
      expect(await verifyQStashSignature(requestWith({ "upstash-signature": sig }))).toBe(false);
    }
  });

  it("rejects when no signing key is configured", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sig = await qstashSignature();
    expect(await verifyQStashSignature(requestWith({ "upstash-signature": sig }))).toBe(false);
  });
});

describe("verifyCronRequest", () => {
  it("accepts either the bearer or a verified QStash signature", async () => {
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", SIGNING_KEY);
    expect(await verifyCronRequest(requestWithBearer("vercel-secret"))).toBe(true);
    const sig = await qstashSignature();
    expect(await verifyCronRequest(requestWith({ "upstash-signature": sig }))).toBe(true);
    expect(await verifyCronRequest(requestWithBearer("nope"))).toBe(false);
  });
});

describe("middleware cron passthrough", () => {
  it.each([
    "/api/cron/reminders",
    "/api/cron/lesson-reminders",
    "/api/cron/head-of-desk",
    "/api/cron/some-future-job",
  ])("lets %s reach its route handler without a session", async (path) => {
    const res = await middleware(requestWithBearer("from-scheduler", path));
    expect(res.status).not.toBe(401);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not open look-alike paths outside /api/cron", async () => {
    const res = await middleware(requestWithBearer("from-scheduler", "/api/cronjobs"));
    expect(res.status).toBe(401);
  });
});
