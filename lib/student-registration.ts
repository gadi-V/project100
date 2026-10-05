import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { buildStudentRecords, type OnboardingAnswers } from "./student-onboarding";
import type { UTMAttribution } from "./utm";

export type NewStudentAccount = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string | null;
  passwordHash: string;
  whatsappUpdates: boolean;
  googleSub?: string;
  /** Null only for a Google sign-up whose step 1-3 answers were lost (e.g. a new tab). */
  answers: OnboardingAnswers | null;
  utm?: UTMAttribution | null;
};

export type CreateStudentResult =
  | { ok: true; user: { id: string; name: string } }
  | { ok: false; status: number; error: string };

const DUPLICATE_PHONE = "מספר הטלפון כבר רשום במערכת. אפשר להתחבר עם הסיסמה הקיימת.";
const DUPLICATE_EMAIL = "כתובת האימייל כבר רשומה במערכת. אפשר להתחבר עם הסיסמה הקיימת.";

class DuplicateAccountError extends Error {}

/** Existing accounts keep their stored values where the new answers have nothing to say. */
function withoutNulls<T extends Record<string, string | null>>(fields: T): Partial<Record<keyof T, string>> {
  const result: Partial<Record<keyof T, string>> = {};
  for (const key of Object.keys(fields) as (keyof T)[]) {
    const value = fields[key];
    if (value !== null) result[key] = value;
  }
  return result;
}

/**
 * Creates the STUDENT user, its StudentProfile and the intake DiagnosticQuiz in one
 * transaction, so a failure never leaves an account without its study details.
 * No package is chosen and no credits are granted at sign-up.
 */
export async function createStudentAccount(input: NewStudentAccount): Promise<CreateStudentResult> {
  const records = input.answers ? buildStudentRecords(input.answers) : null;
  const now = new Date();

  try {
    const user = await prisma.$transaction(async (tx) => {
      const phoneTaken = await tx.user.findUnique({ where: { phone: input.phone }, select: { id: true } });
      if (phoneTaken) throw new DuplicateAccountError(DUPLICATE_PHONE);

      if (input.email) {
        const emailTaken = await tx.user.findFirst({
          where: { email: { equals: input.email, mode: "insensitive" } },
          select: { id: true },
        });
        if (emailTaken) throw new DuplicateAccountError(DUPLICATE_EMAIL);
      }

      return tx.user.create({
        data: {
          name: `${input.firstName} ${input.lastName}`,
          phone: input.phone,
          email: input.email,
          password: input.passwordHash,
          role: "STUDENT",
          lessonCredits: 0,
          isApproved: true,
          googleSub: input.googleSub ?? null,
          termsAcceptedAt: now,
          whatsappUpdatesConsentAt: input.whatsappUpdates ? now : null,
          ...(records?.user ?? {}),
          studentProfile: {
            create: {
              firstName: input.firstName,
              lastName: input.lastName,
              ...(records?.profile ?? {}),
              ...(input.utm ?? {}),
            },
          },
          ...(records ? { diagnosticQuizzes: { create: records.diagnostic } } : {}),
        },
        select: { id: true, name: true },
      });
    });
    return { ok: true, user };
  } catch (error) {
    if (error instanceof DuplicateAccountError) {
      return { ok: false, status: 409, error: error.message };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { ok: false, status: 409, error: "החשבון כבר קיים במערכת. אפשר להתחבר עם הפרטים הקיימים." };
    }
    throw error;
  }
}

/**
 * Saves step 1-3 answers for a student who signed in with an existing account
 * (Google sign-in that matched by email or a returning Google user).
 */
export async function applyOnboardingAnswers(userId: string, answers: OnboardingAnswers): Promise<void> {
  const records = buildStudentRecords(answers);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: withoutNulls(records.user) });
    await tx.studentProfile.upsert({
      where: { userId },
      create: { userId, ...records.profile },
      update: withoutNulls(records.profile),
    });
    await tx.diagnosticQuiz.create({ data: { studentId: userId, ...records.diagnostic } });
  });
}
