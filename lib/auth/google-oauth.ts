import { SignJWT, createRemoteJWKSet, jwtVerify } from "jose";
import { getSecretKey } from "../auth";

/**
 * Google sign-in for students on top of the custom JWT session (no NextAuth).
 * Authorization-code flow: `/api/auth/google` → Google → `/api/auth/google/callback`.
 */

export const GOOGLE_STATE_COOKIE = "project8_google_state";
/** Verified Google identity waiting for a phone number before the account is created. */
export const GOOGLE_PENDING_COOKIE = "project8_google_pending";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const STATE_MAX_AGE = 60 * 10;
const PENDING_MAX_AGE = 60 * 15;
const PENDING_PURPOSE = "google_signup";

let googleJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export type GoogleConfig = { clientId: string; clientSecret: string };

export type GoogleIdentity = {
  sub: string;
  email: string;
  givenName: string;
  familyName: string;
};

export function getGoogleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function googleRedirectUri(requestOrigin: string): string {
  const base =
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    requestOrigin;
  return `${base}/api/auth/google/callback`;
}

export function buildGoogleAuthUrl(config: GoogleConfig, redirectUri: string, state: string): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Exchanges the authorization code and verifies the returned ID token against Google's keys. */
export async function exchangeCodeForIdentity(
  config: GoogleConfig,
  code: string,
  redirectUri: string
): Promise<GoogleIdentity> {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with status ${tokenResponse.status}`);
  }
  const tokens = (await tokenResponse.json()) as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") {
    throw new Error("Google token response has no id_token");
  }

  googleJwks ??= createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const { payload } = await jwtVerify(tokens.id_token, googleJwks, {
    issuer: GOOGLE_ISSUERS,
    audience: config.clientId,
  });

  if (typeof payload.sub !== "string" || typeof payload.email !== "string" || payload.email_verified !== true) {
    throw new Error("Google account email is missing or unverified");
  }
  return {
    sub: payload.sub,
    email: payload.email,
    givenName: typeof payload.given_name === "string" ? payload.given_name : "",
    familyName: typeof payload.family_name === "string" ? payload.family_name : "",
  };
}

export async function signPendingGoogleSignup(identity: GoogleIdentity): Promise<string> {
  return new SignJWT({ ...identity, purpose: PENDING_PURPOSE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_MAX_AGE}s`)
    .sign(getSecretKey());
}

export async function verifyPendingGoogleSignup(token: string | undefined): Promise<GoogleIdentity | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    if (payload.purpose !== PENDING_PURPOSE) return null;
    if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
    return {
      sub: payload.sub,
      email: payload.email,
      givenName: typeof payload.givenName === "string" ? payload.givenName : "",
      familyName: typeof payload.familyName === "string" ? payload.familyName : "",
    };
  } catch {
    return null;
  }
}

function cookieBase(maxAge: number, path: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge,
    path,
  };
}

export function stateCookieOptions(value: string) {
  return { name: GOOGLE_STATE_COOKIE, value, ...cookieBase(STATE_MAX_AGE, "/api/auth/google") };
}

export function clearStateCookieOptions() {
  return { name: GOOGLE_STATE_COOKIE, value: "", ...cookieBase(0, "/api/auth/google") };
}

export function pendingCookieOptions(value: string) {
  return { name: GOOGLE_PENDING_COOKIE, value, ...cookieBase(PENDING_MAX_AGE, "/") };
}

export function clearPendingCookieOptions() {
  return { name: GOOGLE_PENDING_COOKIE, value: "", ...cookieBase(0, "/") };
}
