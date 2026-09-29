import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const tx = {
    user: { update: vi.fn() },
    teacherProfile: { upsert: vi.fn() },
    auditLog: { create: vi.fn() },
  };
  return {
    tx,
    prisma: {
      user: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});

vi.mock("../lib/prisma", () => ({ prisma: db.prisma }));
vi.mock("../lib/audit", () => ({ writeAuditLog: vi.fn() }));

import { dispatchTeacherWelcomeEnvelope } from "../lib/teacher-welcome";

function mockTeacher(phone: string) {
  db.prisma.user.findUnique.mockResolvedValue({
    id: "teacher-1",
    name: "Dana",
    role: "TEACHER",
    phone,
    teacherProfile: null,
  });
}

function stubGateway() {
  vi.stubEnv("WHATSAPP_API_URL", "https://wa.example.test");
  vi.stubEnv("WHATSAPP_API_KEY", "key");
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("DAILY_DOMAIN", "rooms.example.daily.co");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("dispatchTeacherWelcomeEnvelope — WhatsApp recipient", () => {
  it("sends to the normalized WhatsApp JID of a local Israeli number", async () => {
    mockTeacher("054-123-4567");
    const fetchMock = stubGateway();

    const result = await dispatchTeacherWelcomeEnvelope({ teacherId: "teacher-1" });

    expect(result.whatsappSent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://wa.example.test/sendMessage");
    expect(JSON.parse(String(init.body))).toMatchObject({
      phone: "972541234567",
      chatId: "972541234567@c.us",
    });
  });

  it.each(["0000000000", "12345", "not-a-phone", ""])(
    "does not send and logs an error for invalid phone %j",
    async (phone) => {
      mockTeacher(phone);
      const fetchMock = stubGateway();
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await dispatchTeacherWelcomeEnvelope({ teacherId: "teacher-1" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.whatsappSent).toBe(false);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid phone for teacher teacher-1"),
        expect.anything()
      );
      // Approval is still persisted; only the notification is skipped.
      expect(result.success).toBe(true);
      expect(db.tx.teacherProfile.upsert).toHaveBeenCalledTimes(1);
    }
  );

  it("reports whatsappSent=false when the gateway rejects the message", async () => {
    mockTeacher("0541234567");
    vi.stubEnv("WHATSAPP_API_URL", "https://wa.example.test");
    vi.stubEnv("WHATSAPP_API_KEY", "key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await dispatchTeacherWelcomeEnvelope({ teacherId: "teacher-1" });

    expect(result.whatsappSent).toBe(false);
  });
});

describe("dispatchTeacherWelcomeEnvelope — Daily domain", () => {
  it("builds the permanent room URL from DAILY_DOMAIN without warning", async () => {
    mockTeacher("0541234567");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchTeacherWelcomeEnvelope({ teacherId: "teacher-1" });

    expect(result.permanentRoomUrl).toBe("https://rooms.example.daily.co/tutor-dana");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to project100.daily.co and warns when DAILY_DOMAIN is unset", async () => {
    vi.stubEnv("DAILY_DOMAIN", "");
    mockTeacher("0541234567");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await dispatchTeacherWelcomeEnvelope({ teacherId: "teacher-1" });

    expect(result.permanentRoomUrl).toBe("https://project100.daily.co/tutor-dana");
    expect(result.permanentRoomUrl).not.toContain("project8.daily.co");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DAILY_DOMAIN"));
  });

  it("prefers an explicit customRoomUrl", async () => {
    mockTeacher("0541234567");

    const result = await dispatchTeacherWelcomeEnvelope({
      teacherId: "teacher-1",
      customRoomUrl: "https://custom.daily.co/room",
    });

    expect(result.permanentRoomUrl).toBe("https://custom.daily.co/room");
  });
});
