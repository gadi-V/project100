/**
 * Platform environment readers. Values come from the Next.js env
 * (root `.env` locally, the host env in production). `agents_hive/.env`
 * is not loaded here — serverless bundles do not include that file.
 */

const LOCAL_APP_URL = "http://localhost:3000";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Public origin for links the server builds (classroom, WhatsApp, Stripe).
 * `fallback` is used only when both `APP_URL` and `NEXT_PUBLIC_APP_URL` are empty.
 * Local development falls back to `http://localhost:3000`.
 */
export function resolveAppUrl(fallback: string = LOCAL_APP_URL): string {
  const fromEnv =
    process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || "";
  return (fromEnv || fallback).replace(/\/$/, "");
}

/** OpenRouter key. Null when unset — callers must not invent a key. */
export function resolveOpenRouterApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key || null;
}

/** OpenRouter API origin. Defaults to the public API when unset. */
export function resolveOpenRouterBaseUrl(): string {
  return (
    process.env.OPENROUTER_BASE_URL?.trim().replace(/\/$/, "") ||
    DEFAULT_OPENROUTER_BASE_URL
  );
}

/**
 * Parent domain for the session cookie (for example `.project100.co.il`).
 * Empty or whitespace means a host-only cookie, which is the local-dev default.
 */
export function resolveSessionCookieDomain(): string | undefined {
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return domain || undefined;
}
