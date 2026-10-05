import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { signSession, sessionCookieOptions } from "../../../../lib/auth";
import { parseStudentSignup } from "../../../../lib/student-onboarding";
import { createStudentAccount } from "../../../../lib/student-registration";

/**
 * Step 4 of the student wizard: creates the STUDENT account, its StudentProfile and the
 * intake diagnostic from steps 1-3 in one transaction, then signs the student in.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = parseStudentSignup(body);
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
    }
    const input = parsed.value;

    const result = await createStudentAccount({
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, 10),
      whatsappUpdates: input.whatsappUpdates,
      answers: input.answers,
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }

    const response = NextResponse.json(
      { success: true, data: { name: result.user.name, redirectTo: "/dashboard" } },
      { status: 201 }
    );
    response.cookies.set(sessionCookieOptions(await signSession(result.user.id, "STUDENT")));
    return response;
  } catch (error: unknown) {
    console.error("STUDENT REGISTER ERROR:", error);
    return NextResponse.json(
      { success: false, error: "לא הצלחנו לפתוח את החשבון. נסו שוב בעוד רגע." },
      { status: 500 }
    );
  }
}
