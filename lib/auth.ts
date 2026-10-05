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
};

export function getSecretKey() {
  const secret =
    process.env.AUTH_SECRET?.trim() || BUILD_FALLBACK_AUTH_SECRET;
  return new TextEncoder().encode(secret);
}

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecretKey());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (typeof payload.userId !== "string") return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
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
  };
}
