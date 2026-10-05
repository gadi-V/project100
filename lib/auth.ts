import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "project8_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

/**
 * Build-only fallback when AUTH_SECRET is unset (e.g. Vercel preview build
 * without project secrets). Production and any real session signing MUST set
 * a strong AUTH_SECRET — this dummy must never be relied on at runtime.
 */
const BUILD_FALLBACK_AUTH_SECRET =
  "build-time-only-auth-secret-not-for-production";

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
  const secret =
    process.env.AUTH_SECRET?.trim() || BUILD_FALLBACK_AUTH_SECRET;
  return new TextEncoder().encode(secret);
}

export async function signSession(userId: string, role?: string): Promise<string> {
  return new SignJWT(role ? { userId, role } : { userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecretKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
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
  const domain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return domain ? domain : undefined;
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
