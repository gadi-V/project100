import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUILD_FALLBACK_AUTH_SECRET,
  assertProductionAuthSecret,
  getSecretKey,
  signSession,
  verifySession,
} from "../lib/auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AUTH_SECRET", () => {
  it("signs with the build fallback in development when AUTH_SECRET is unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_SECRET", "");

    const token = await signSession("user-1", "STUDENT");

    expect(await verifySession(token)).toEqual({ userId: "user-1", role: "STUDENT" });
  });

  it("throws in production when AUTH_SECRET is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("AUTH_SECRET", "");

    expect(() => getSecretKey()).toThrow(/AUTH_SECRET/);
    expect(() => assertProductionAuthSecret()).toThrow(/build-time fallback/);
    await expect(signSession("user-1")).rejects.toThrow(/AUTH_SECRET/);
    await expect(verifySession("not-a-token")).rejects.toThrow(/AUTH_SECRET/);
  });

  it("throws in production when AUTH_SECRET is the hardcoded fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("AUTH_SECRET", BUILD_FALLBACK_AUTH_SECRET);

    expect(() => getSecretKey()).toThrow(/AUTH_SECRET/);
  });

  it("signs in production when AUTH_SECRET is a real value", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("AUTH_SECRET", "production-auth-secret-at-least-32-chars");

    const token = await signSession("user-2", "TEACHER");

    expect(await verifySession(token)).toEqual({ userId: "user-2", role: "TEACHER" });
  });

  it("keeps the fallback during next build so a secret-less build can compile", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("AUTH_SECRET", "");

    expect(() => getSecretKey()).not.toThrow();
  });
});
