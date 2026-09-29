import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { signSession } from "../lib/auth";

const cookieJar = vi.hoisted(() => ({ session: undefined as string | undefined }));

const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  teacherProfileUpsert: vi.fn(),
  vettingStepLogUpsert: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "project8_session" && cookieJar.session
        ? { name, value: cookieJar.session }
        : undefined,
  }),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: db.userFindUnique },
    $transaction: db.transaction,
  },
}));

const SESSION_USER = {
  id: "applicant-session-user",
  name: "Applicant",
  role: "STUDENT",
  lessonCredits: 0,
  isApproved: false,
};
const VICTIM_ID = "victim-user";

function applyRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("https://project100.vercel.app/api/teachers/apply", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function loadApplyRoute() {
  return (await import("../app/api/teachers/apply/route")).POST;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "vitest-auth-secret-at-least-32-characters");
  cookieJar.session = undefined;
  db.userFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === SESSION_USER.id ? SESSION_USER : null
  );
  db.teacherProfileUpsert.mockImplementation(
    async ({ where }: { where: { userId: string } }) => ({
      id: `profile-of-${where.userId}`,
      userId: where.userId,
    })
  );
  db.vettingStepLogUpsert.mockResolvedValue({});
  db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      teacherProfile: { upsert: db.teacherProfileUpsert },
      vettingStepLog: { upsert: db.vettingStepLogUpsert },
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/teachers/apply — IDOR", () => {
  it("rejects a request without a session with 401, even with body.userId", async () => {
    const POST = await loadApplyRoute();

    const res = await POST(applyRequest({ userId: VICTIM_ID, cvUrl: "https://cv.example/a.pdf" }));

    expect(res.status).toBe(401);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.teacherProfileUpsert).not.toHaveBeenCalled();
  });

  it("rejects a spoofed x-user-id header without a session with 401", async () => {
    const POST = await loadApplyRoute();

    const res = await POST(
      applyRequest({ cvUrl: "https://cv.example/a.pdf" }, { "x-user-id": VICTIM_ID })
    );

    expect(res.status).toBe(401);
    expect(db.teacherProfileUpsert).not.toHaveBeenCalled();
  });

  it("rejects a forged session cookie with 401", async () => {
    cookieJar.session = "forged.jwt.token";
    const POST = await loadApplyRoute();

    const res = await POST(applyRequest({ userId: VICTIM_ID, cvUrl: "https://cv.example/a.pdf" }));

    expect(res.status).toBe(401);
    expect(db.teacherProfileUpsert).not.toHaveBeenCalled();
  });

  it("ignores body.userId and x-user-id and applies for the session user only", async () => {
    cookieJar.session = await signSession(SESSION_USER.id);
    const POST = await loadApplyRoute();

    const res = await POST(
      applyRequest(
        {
          userId: VICTIM_ID,
          cvUrl: "https://cv.example/a.pdf",
          bankName: "Attacker Bank",
          accountNumber: "000-attacker",
        },
        { "x-user-id": VICTIM_ID }
      )
    );

    expect(res.status).toBe(201);
    expect(db.teacherProfileUpsert).toHaveBeenCalledTimes(1);
    const [args] = db.teacherProfileUpsert.mock.calls[0] as [
      { where: { userId: string }; create: { userId: string } },
    ];
    expect(args.where).toEqual({ userId: SESSION_USER.id });
    expect(args.create.userId).toBe(SESSION_USER.id);
    expect(JSON.stringify(db.teacherProfileUpsert.mock.calls)).not.toContain(VICTIM_ID);
    expect(await res.json()).toMatchObject({ userId: SESSION_USER.id });
  });

  it("still validates the CV link for an authenticated applicant", async () => {
    cookieJar.session = await signSession(SESSION_USER.id);
    const POST = await loadApplyRoute();

    const res = await POST(applyRequest({ userId: VICTIM_ID }));

    expect(res.status).toBe(400);
    expect(db.teacherProfileUpsert).not.toHaveBeenCalled();
  });
});
