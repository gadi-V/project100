import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../../../lib/prisma";
import { signSession, sessionCookieOptions } from "../../../lib/auth";

/**
 * Public sign-up for students and parents only. Teacher accounts are never created here:
 * candidates apply through `/careers` and are onboarded by the management team.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, phone, email, password, role } = body;

    if (!name || !phone || !password || !role) {
      return NextResponse.json(
        { error: "שם, טלפון, סיסמה ותפקיד הם שדות חובה" },
        { status: 400 }
      );
    }

    if (typeof role === "string" && role.toUpperCase() === "TEACHER") {
      return NextResponse.json(
        { error: "הרשמת מורים מתבצעת דרך הגשת מועמדות בעמוד /careers" },
        { status: 403 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: "הסיסמה חייבת להכיל לפחות 6 תווים" },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { phone },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "מספר הטלפון כבר רשום במערכת" },
        { status: 400 }
      );
    }

    if (email) {
      const existingEmail = await prisma.user.findUnique({
        where: { email },
      });
      if (existingEmail) {
        return NextResponse.json(
          { error: "כתובת האימייל כבר רשומה במערכת" },
          { status: 400 }
        );
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        phone,
        email: email || null,
        password: hashedPassword,
        role: "STUDENT",
        lessonCredits: 0,
        isApproved: true,
      },
    });

    const token = await signSession(newUser.id, newUser.role);

    const response = NextResponse.json(
      {
        message: "המשתמש נוצר בהצלחה",
        user: {
          id: newUser.id,
          name: newUser.name,
          role: newUser.role,
          isApproved: newUser.isApproved,
        },
      },
      { status: 201 }
    );

    response.cookies.set(sessionCookieOptions(token));
    return response;
  } catch (error: unknown) {
    console.error("CRITICAL REGISTER ERROR:", error);
    const message =
      error instanceof Error && error.message.includes("DATABASE_URL")
        ? "שגיאת הגדרת מסד נתונים — בדקו את DATABASE_URL ב-.env"
        : "שגיאה פנימית בשרת במהלך הרישום";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
