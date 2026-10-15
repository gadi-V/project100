import { afterEach, describe, expect, it, vi } from "vitest";
import { P0_ENV_KEYS, P1_ENV_CHECKS, assertProductionEnv, warnDisabledSubsystems } from "../lib/env-validator";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function stubP0() {
  for (const key of P0_ENV_KEYS) vi.stubEnv(key, `present-${key}`);
}

function stubP1() {
  for (const check of P1_ENV_CHECKS) {
    for (const key of check.keys) vi.stubEnv(key, `present-${key}`);
  }
}

function clearP1() {
  for (const check of P1_ENV_CHECKS) {
    for (const key of check.keys) vi.stubEnv(key, "");
  }
}

describe("assertProductionEnv", () => {
  it("throws in production when a P0 variable is missing and does not echo values", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://user:supersecret@localhost/db");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    expect(() => assertProductionEnv()).toThrow(/UPSTASH_REDIS_REST_URL/);
    expect(() => assertProductionEnv()).toThrow(/UPSTASH_REDIS_REST_TOKEN/);
    try {
      assertProductionEnv();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("supersecret");
      expect(message).not.toContain("postgresql://");
    }
  });

  it("does not throw during the Next.js production build when secrets are absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("does not throw outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

    expect(() => assertProductionEnv()).not.toThrow();
  });

  it("does not throw in production when every P0 variable is set, even if P1 is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubP0();
    clearP1();

    expect(() => assertProductionEnv()).not.toThrow();
  });
});

describe("warnDisabledSubsystems", () => {
  it("warns that each missing subsystem is disabled and does not throw", () => {
    vi.stubEnv("NODE_ENV", "production");
    stubP0();
    clearP1();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => warnDisabledSubsystems()).not.toThrow();

    const lines = warn.mock.calls.map((call) => call.join(" "));
    expect(lines).toEqual([
      "[env] Payments is disabled (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET are not set)",
      "[env] Chat is disabled (WHATSAPP_API_URL, WHATSAPP_API_KEY are not set)",
      "[env] Storage is disabled (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY are not set)",
      "[env] SMS/Recovery is disabled (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER are not set)",
      "[env] Auth is disabled (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET are not set)",
    ]);
    expect(lines.join("\n")).not.toContain("present-");
  });

  it("stays quiet outside production and when every P1 variable is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubEnv("NODE_ENV", "test");
    warnDisabledSubsystems();

    vi.stubEnv("NODE_ENV", "production");
    stubP0();
    stubP1();
    warnDisabledSubsystems();

    expect(warn).not.toHaveBeenCalled();
  });
});
