/**
 * Production Readiness — pre-flight checks for a release (no writes anywhere).
 *
 *   1. ENV       — the keys production depends on are set and well-formed. Values are masked
 *                  (first 4 + last 4 characters; short values are fully hidden).
 *   2. DATABASE  — live `SELECT 1` against Neon through Prisma, cold + warm latency.
 *   3. WHATSAPP  — the quad-group gateway answers HTTP (only when `WHATSAPP_API_URL` is set).
 *   4. HEALTH    — `GET {base}/api/health` answers `200` with `status: "UP"`.
 *
 * Key names follow what the code reads: sessions are signed with `AUTH_SECRET` (custom JWT, `lib/auth.ts`;
 * `NEXTAUTH_SECRET` is not read) and the gateway is `WHATSAPP_API_URL` + `WHATSAPP_API_KEY` (`lib/whatsapp.ts`;
 * `WHATSAPP_GATEWAY_URL` is not read). Setting only the unread name is reported as a failure.
 *
 * Levels: OK · WARN (optional integration missing, the app degrades gracefully) · FAIL (blocks release).
 * Exit: 0 when nothing failed, 1 otherwise.
 *
 * Run: npx tsx scripts/verify-production-readiness.ts [--url=https://your-app.example]
 *      (base URL defaults to APP_URL, then NEXT_PUBLIC_APP_URL, then http://localhost:3000)
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { normalizeToE164 } from "../lib/utils/phone";

type Level = "OK" | "WARN" | "FAIL";
type Check = { group: string; name: string; level: Level; detail: string };

const results: Check[] = [];
const COLORS: Record<Level, string> = { OK: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };
const RESET = "\x1b[0m";
const TIMEOUT_MS = 10_000;
const MIN_AUTH_SECRET_LENGTH = 32;

function record(group: string, name: string, level: Level, detail: string) {
  results.push({ group, name, level, detail });
  console.log(`  ${COLORS[level]}[${level}]${RESET} ${group} · ${name}: ${detail}`);
}

function env(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

function mask(value: string): string {
  if (value.length < 12) return `**** (${value.length} chars)`;
  return `${value.slice(0, 4)}…${value.slice(-4)} (${value.length} chars)`;
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)),
  ]);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 160);
}

// ─── 1. Environment ───

function checkDatabaseUrl() {
  const value = env("DATABASE_URL");
  if (!value) return record("ENV", "DATABASE_URL", "FAIL", "missing — the app cannot reach Neon");
  const url = parseUrl(value);
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) {
    return record("ENV", "DATABASE_URL", "FAIL", `${mask(value)} — expected a postgres:// or postgresql:// URL`);
  }
  const neon = url.hostname.endsWith(".neon.tech");
  const ssl = url.searchParams.get("sslmode");
  if (neon && ssl !== "require" && ssl !== "verify-full") {
    return record("ENV", "DATABASE_URL", "WARN", `${mask(value)} — Neon host without sslmode=require`);
  }
  record("ENV", "DATABASE_URL", "OK", `${mask(value)} — ${neon ? "Neon" : "PostgreSQL"} host, sslmode=${ssl ?? "default"}`);
}

function checkAuthSecret() {
  const value = env("AUTH_SECRET");
  if (!value) {
    const unread = env("NEXTAUTH_SECRET") ? " (NEXTAUTH_SECRET is set but the app reads AUTH_SECRET)" : "";
    return record("ENV", "AUTH_SECRET", "FAIL", `missing${unread} — sessions would use the build-only fallback`);
  }
  if (value.length < MIN_AUTH_SECRET_LENGTH) {
    return record("ENV", "AUTH_SECRET", "FAIL", `${mask(value)} — shorter than ${MIN_AUTH_SECRET_LENGTH} characters`);
  }
  record("ENV", "AUTH_SECRET", "OK", `${mask(value)} — HS256 session signing key`);
}

function checkDailyKey() {
  const value = env("DAILY_API_KEY");
  if (!value) return record("ENV", "DAILY_API_KEY", "WARN", "not set — lessons fall back to mock rooms");
  if (/\s/.test(value) || value.length < 20) {
    return record("ENV", "DAILY_API_KEY", "FAIL", `${mask(value)} — expected a single token of 20+ characters`);
  }
  record("ENV", "DAILY_API_KEY", "OK", `${mask(value)} — lesson rooms`);
}

function checkWhatsApp(): URL | null {
  const apiUrl = env("WHATSAPP_API_URL");
  const apiKey = env("WHATSAPP_API_KEY");
  const adminPhone = env("WHATSAPP_ADMIN_PHONE");
  let gateway: URL | null = null;

  if (!apiUrl) {
    if (env("WHATSAPP_GATEWAY_URL")) {
      record("ENV", "WHATSAPP_API_URL", "FAIL", "WHATSAPP_GATEWAY_URL is set but the app reads WHATSAPP_API_URL");
    } else {
      record("ENV", "WHATSAPP_API_URL", "WARN", "not set — quad groups and WhatsApp messages are skipped");
    }
  } else {
    const url = parseUrl(apiUrl);
    if (!url || !["https:", "http:"].includes(url.protocol)) {
      record("ENV", "WHATSAPP_API_URL", "FAIL", `${mask(apiUrl)} — expected an http(s) URL`);
    } else {
      gateway = url;
      record("ENV", "WHATSAPP_API_URL", url.protocol === "https:" ? "OK" : "WARN", `${url.origin} — ${url.protocol === "https:" ? "gateway" : "not HTTPS"}`);
    }
  }

  if (!apiKey) record("ENV", "WHATSAPP_API_KEY", apiUrl ? "FAIL" : "WARN", apiUrl ? "missing while WHATSAPP_API_URL is set" : "not set");
  else record("ENV", "WHATSAPP_API_KEY", "OK", mask(apiKey));

  if (!adminPhone) {
    record("ENV", "WHATSAPP_ADMIN_PHONE", "WARN", "not set — quad groups open without the admin seat");
  } else {
    try {
      const e164 = normalizeToE164(adminPhone);
      record("ENV", "WHATSAPP_ADMIN_PHONE", "OK", `${e164.slice(0, 5)}…${e164.slice(-3)} — valid E.164`);
    } catch (error: unknown) {
      record("ENV", "WHATSAPP_ADMIN_PHONE", "FAIL", errorText(error));
    }
  }
  return gateway;
}

// ─── 2. Database ───

async function checkDatabase() {
  if (!env("DATABASE_URL")) return record("DATABASE", "SELECT 1", "FAIL", "skipped — DATABASE_URL missing");
  const prisma = new PrismaClient();
  try {
    const ping = async () => {
      const started = performance.now();
      await withTimeout(prisma.$queryRaw`SELECT 1`, "SELECT 1");
      return Math.round(performance.now() - started);
    };
    const cold = await ping();
    const warm: number[] = [];
    for (let i = 0; i < 3; i++) warm.push(await ping());
    const avg = Math.round(warm.reduce((sum, ms) => sum + ms, 0) / warm.length);
    record("DATABASE", "SELECT 1", "OK", `cold ${cold} ms (connect + query), warm avg ${avg} ms over ${warm.length} pings`);
  } catch (error: unknown) {
    record("DATABASE", "SELECT 1", "FAIL", errorText(error));
  } finally {
    await prisma.$disconnect();
  }
}

// ─── 3. WhatsApp gateway ───

async function checkGateway(gateway: URL | null) {
  if (!gateway) return record("WHATSAPP", "Gateway reachability", "WARN", "skipped — WHATSAPP_API_URL not set");
  const started = performance.now();
  try {
    const res = await withTimeout(fetch(gateway.origin, { method: "GET", redirect: "manual" }), "gateway request");
    const ms = Math.round(performance.now() - started);
    const level: Level = res.status >= 500 ? "FAIL" : "OK";
    record("WHATSAPP", "Gateway reachability", level, `${gateway.origin} answered HTTP ${res.status} in ${ms} ms`);
  } catch (error: unknown) {
    record("WHATSAPP", "Gateway reachability", "FAIL", `${gateway.origin} unreachable: ${errorText(error)}`);
  }
}

// ─── 4. /api/health ───

function appBase(): string {
  const arg = process.argv.find((a) => a.startsWith("--url="))?.slice("--url=".length);
  return (arg || env("APP_URL") || env("NEXT_PUBLIC_APP_URL") || "http://localhost:3000").replace(/\/$/, "");
}

async function checkHealth() {
  const url = `${appBase()}/api/health`;
  const started = performance.now();
  try {
    const res = await withTimeout(fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" }), "health request");
    const ms = Math.round(performance.now() - started);
    const body = (await res.json().catch(() => null)) as { data?: { status?: string; database?: string; latencyMs?: number } } | null;
    const up = res.status === 200 && body?.data?.status === "UP" && body.data.database === "UP";
    record(
      "HEALTH",
      "GET /api/health",
      up ? "OK" : "FAIL",
      `${url} → HTTP ${res.status}, status=${body?.data?.status ?? "?"}, db=${body?.data?.database ?? "?"}, server db ping ${body?.data?.latencyMs ?? "?"} ms, round trip ${ms} ms`
    );
  } catch (error: unknown) {
    record("HEALTH", "GET /api/health", "FAIL", `${url} unreachable: ${errorText(error)}`);
  }
}

async function main() {
  console.log("=== PRODUCTION READINESS ===\n");
  console.log("[1/4] ENVIRONMENT");
  checkDatabaseUrl();
  checkAuthSecret();
  checkDailyKey();
  const gateway = checkWhatsApp();
  console.log("\n[2/4] DATABASE");
  await checkDatabase();
  console.log("\n[3/4] WHATSAPP GATEWAY");
  await checkGateway(gateway);
  console.log("\n[4/4] HEALTH ENDPOINT");
  await checkHealth();

  const count = (level: Level) => results.filter((r) => r.level === level).length;
  const failed = count("FAIL");
  const verdict = failed > 0 ? "NOT READY" : count("WARN") > 0 ? "READY WITH WARNINGS" : "READY";
  console.log(`\n=== ${verdict}: ${count("OK")} ok, ${count("WARN")} warn, ${failed} fail ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("Readiness check crashed:", error);
  process.exit(1);
});
