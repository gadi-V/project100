import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { signSession, sessionCookieOptions } from "../../../../../lib/auth";
import { getCurrentUser } from "../../../../../lib/session";
import {
  GOOGLE_PENDING_COOKIE,
  clearPendingCookieOptions,
  verifyPendingGoogleSignup,
} from "../../../../../lib/auth/google-oauth";
import {
  INVALID_PHONE_ERROR,
  normalizeIsraeliMobile,
  parseOnboardingAnswers,
  type OnboardingAnswers,
} from "../../../../../lib/student-onboarding";
import { applyOnboardingAnswers, createStudentAccount } from "../../../../../lib/student-registration";

type CompletionStatus =
  | { status: "signed_in" }
  | { status: "needs_details"; email: string; firstName: string; lastName: string }
  | { status: "expired" };

/** Tells `/auth/callback` whether the Google round trip ended signed in or still needs a phone number. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  let data: CompletionStatus = { status: "expired" };
  if (user) {
    data = { status: "signed_in" };
  } else {
    const pending = await verifyPendingGoogleSignup(request.cookies.get(GOOGLE_PENDING_COOKIE)?.value);
    if (pending) {
      data = {
        status: "needs_details",
        email: pending.email,
        firstName: pending.givenName,
        lastName: pending.familyName,
      };
    }
  }
  return NextResponse.json({ success: true, data });
}

function readAnswers(raw: unknown): OnboardingAnswers | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseOnboardingAnswers(raw);
  return parsed.ok ? parsed.value : null;
}

/**
 * Finishes a Google sign-in: saves the step 1-3 answers carried in sessionStorage to the
 * signed-in student's profile, or creates the account for a new Google identity.
 */
export async function POST(request: NextRequest) {
  try {
    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const answers = readAnswers(body.answers);

    const user = await getCurrentUser();
    if (user) {
      if (user.role === "STUDENT" && answers) {
        await applyOnboardingAnswers(user.id, answers);
      }
      return NextResponse.json({ success: true, data: { redirectTo: "/dashboard" } });
    }

    const pending = await verifyPendingGoogleSignup(request.cookies.get(GOOGLE_PENDING_COOKIE)?.value);
    if (!pending) {
      return NextResponse.json(
        { success: false, error: "ההתחברות עם Google פגה. נסו שוב מדף ההרשמה." },
        { status: 401 }
      );
    }

    const firstName = typeof body.firstName === "string" ? body.firstName.trim().slice(0, 60) : "";
    const lastName = typeof body.lastName === "string" ? body.lastName.trim().slice(0, 60) : "";
    if (!firstName || !lastName) {
      return NextResponse.json({ success: false, error: "יש למלא שם פרטי ושם משפחה" }, { status: 400 });
    }
    const phone = normalizeIsraeliMobile(typeof body.phone === "string" ? body.phone : "");
    if (!phone) {
      return NextResponse.json({ success: false, error: INVALID_PHONE_ERROR }, { status: 400 });
    }
    if (body.acceptTerms !== true) {
      return NextResponse.json(
        { success: false, error: "יש לאשר את תנאי השימוש ומדיניות הפרטיות" },
        { status: 400 }
      );
    }

    const result = await createStudentAccount({
      firstName,
      lastName,
      phone,
      email: pending.email,
      // Google accounts sign in without a password until the student sets one via "שכחתי סיסמה".
      passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10),
      whatsappUpdates: body.whatsappUpdates === true,
      googleSub: pending.sub,
      answers,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    const response = NextResponse.json(
      { success: true, data: { redirectTo: "/dashboard" } },
      { status: 201 }
    );
    response.cookies.set(clearPendingCookieOptions());
    response.cookies.set(sessionCookieOptions(await signSession(result.user.id)));
    return response;
  } catch (error: unknown) {
    console.error("GOOGLE SIGNUP COMPLETE ERROR:", error);
    return NextResponse.json(
      { success: false, error: "לא הצלחנו לסיים את ההרשמה. נסו שוב בעוד רגע." },
      { status: 500 }
    );
  }
}
