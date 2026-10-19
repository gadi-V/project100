import { SignJWT, jwtVerify } from "jose";
import { resolveSessionCookieDomain } from "./platform-env";

export const SESSION_COOKIE = "project8_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Build-only fallback when AUTH_SECRET is unset (e.g. `next build` without
 * project secrets). Development may sign with this dummy. Production runtime
 * must not: a missing or identical value throws before any JWT is minted.
 */
export const BUILD_FALLBACK_AUTH_SECRET =
  "build-time-only-auth-secret-not-for-production";

/** Production server, not `next build` (which often has no project secrets). */
function isProductionAuthRuntime(): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  return true;
}

function resolveAuthSecret(): string {
  const fromEnv = process.env.AUTH_SECRET?.trim() ?? "";
  const secret = fromEnv || BUILD_FALLBACK_AUTH_SECRET;

  if (
    isProductionAuthRuntime() &&
    (fromEnv.length === 0 || secret === BUILD_FALLBACK_AUTH_SECRET)
  ) {
    throw new Error(
      "AUTH_SECRET must be set to a unique value in production. Refusing to sign session tokens with the build-time fallback."
    );
  }

  return secret;
}

/**
 * Fail closed at process start. Called from `instrumentation.ts` so a
 * production server never boots while session JWTs would be signed with the
 * build-time fallback.
 */
export function assertProductionAuthSecret(): void {
  resolveAuthSecret();
}

export type SessionPayload = {
  userId: string;
  /**
   * Role at sign-in time. A routing hint for the proxy only (e.g. keeping students off the
   * teachers subdomain); authorization must still re-read the role from the database.
   * Absent on tokens issued before Sprint 22.
   */
  role?: string;
};

export function getSecretKey() {
  return new TextEncoder().encode(resolveAuthSecret());
}

export async function signSession(userId: string, role?: string): Promise<string> {
  return new SignJWT(role ? { userId, role } : { userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecretKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  const key = getSecretKey();
  try {
    const { payload } = await jwtVerify(token, key);
    if (typeof payload.userId !== "string") return null;
    return typeof payload.role === "string"
      ? { userId: payload.userId, role: payload.role }
      : { userId: payload.userId };
  } catch {
    return null;
  }
}

/**
 * Parent domain shared by the main site and the teachers subdomain (e.g. ".project100.co.il"),
 * so one sign-in is recognized on both. Unset means a host-only cookie (local dev, previews).
 */
export function sessionCookieDomain(): string | undefined {
  return resolveSessionCookieDomain();
}

function domainOption(): { domain?: string } {
  const domain = sessionCookieDomain();
  return domain ? { domain } : {};
}

export function sessionCookieOptions(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_MAX_AGE,
    path: "/",
    ...domainOption(),
  };
}

export function clearSessionCookieOptions() {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 0,
    path: "/",
    ...domainOption(),
  };
}
