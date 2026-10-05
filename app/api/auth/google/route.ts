import { NextResponse, type NextRequest } from "next/server";
import {
  buildGoogleAuthUrl,
  getGoogleConfig,
  googleRedirectUri,
  stateCookieOptions,
} from "../../../../lib/auth/google-oauth";

export async function GET(request: NextRequest) {
  const config = getGoogleConfig();
  if (!config) {
    return NextResponse.redirect(new URL("/register/student?google=unavailable", request.url));
  }

  const state = crypto.randomUUID();
  const response = NextResponse.redirect(
    buildGoogleAuthUrl(config, googleRedirectUri(request.nextUrl.origin), state)
  );
  response.cookies.set(stateCookieOptions(state));
  return response;
}
