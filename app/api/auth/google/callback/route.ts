import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "../../../../../lib/prisma";
import { signSession, sessionCookieOptions } from "../../../../../lib/auth";
import {
  GOOGLE_STATE_COOKIE,
  clearPendingCookieOptions,
  clearStateCookieOptions,
  exchangeCodeForIdentity,
  getGoogleConfig,
  googleRedirectUri,
  pendingCookieOptions,
  signPendingGoogleSignup,
} from "../../../../../lib/auth/google-oauth";

function backToWizard(request: NextRequest, reason: "failed" | "unavailable" | "staff") {
  const response = NextResponse.redirect(new URL(`/register/student?google=${reason}`, request.url));
  response.cookies.set(clearStateCookieOptions());
  return response;
}

/**
 * Google redirects here after consent. Existing student accounts are signed in;
 * a new identity is parked in a short-lived signed cookie until `/auth/callback`
 * collects the phone number and consent.
 */
export async function GET(request: NextRequest) {
  const config = getGoogleConfig();
  if (!config) return backToWizard(request, "unavailable");

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const expectedState = request.cookies.get(GOOGLE_STATE_COOKIE)?.value;
  if (!code || !state || !expectedState || state !== expectedState) {
    return backToWizard(request, "failed");
  }

  try {
    const identity = await exchangeCodeForIdentity(
      config,
      code,
      googleRedirectUri(request.nextUrl.origin)
    );

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { googleSub: identity.sub },
          { email: { equals: identity.email, mode: "insensitive" } },
        ],
      },
      select: { id: true, role: true, googleSub: true },
    });

    const response = NextResponse.redirect(new URL("/auth/callback", request.url));
    response.cookies.set(clearStateCookieOptions());

    if (existing) {
      // Staff accounts sign in with their password only.
      if (existing.role !== "STUDENT") return backToWizard(request, "staff");
      if (!existing.googleSub) {
        await prisma.user.update({ where: { id: existing.id }, data: { googleSub: identity.sub } });
      }
      response.cookies.set(clearPendingCookieOptions());
      response.cookies.set(sessionCookieOptions(await signSession(existing.id, existing.role)));
      return response;
    }

    response.cookies.set(pendingCookieOptions(await signPendingGoogleSignup(identity)));
    return response;
  } catch (error: unknown) {
    console.error("GOOGLE OAUTH CALLBACK ERROR:", error);
    return backToWizard(request, "failed");
  }
}
