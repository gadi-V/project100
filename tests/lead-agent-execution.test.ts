import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  fallbackLeadFindMany: vi.fn(),
  auditLogFindMany: vi.fn(),
  auditLogCreate: vi.fn(),
}));

const wa = vi.hoisted(() => ({
  sendWhatsAppMessage: vi.fn(),
  isWhatsAppConfigured: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findMany: db.userFindMany },
    fallbackLead: { findMany: db.fallbackLeadFindMany },
    auditLog: { findMany: db.auditLogFindMany, create: db.auditLogCreate },
  },
}));

vi.mock("../lib/whatsapp", () => wa);

type IdFilter = { in?: string[]; notIn?: string[] };
type FindManyArgs = { where: { id?: IdFilter }; take?: number };
type AuditCreateArgs = {
  data: {
    action: string;
    entityType: string;
    entityId: string;
    actorId: string | null;
    metadata: Record<string, unknown>;
  };
};

const NOW = new Date("2026-09-29T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const LLM_TEXT = "היי, ראינו שנרשמת. נשמח להציע מורה ושעה שנוחה לך.";

function userLead(id: string, phone: string, createdAt = hoursAgo(10)) {
  return {
    id,
    name: `נועה ${id}`,
    phone,
    createdAt,
    classTrack: null,
    trackType: null,
    degreeField: null,
    academicYear: null,
    targetOrganization: null,
    diagnosticQuizzes: [],
  };
}

function fallbackLead(id: string, phone: string, createdAt = hoursAgo(5)) {
  return { id, name: `עידו ${id}`, phone, createdAt, grade: "ח׳", requestedHours: "בוקר" };
}

/** Emulates Prisma's `id: { in }` / `id: { notIn }` filtering on a fixed table. */
function table<T extends { id: string }>(rows: T[]) {
  return async ({ where, take }: FindManyArgs) => {
    const filtered = rows.filter((row) => {
      if (where.id?.in) return where.id.in.includes(row.id);
      if (where.id?.notIn) return !where.id.notIn.includes(row.id);
      return true;
    });
    return typeof take === "number" ? filtered.slice(0, take) : filtered;
  };
}

function stubLLM() {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ message: LLM_TEXT }) } }] }),
      { status: 200 }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function auditCreates(): AuditCreateArgs["data"][] {
  return db.auditLogCreate.mock.calls.map(([args]) => (args as AuditCreateArgs).data);
}

async function loadLeadAgent() {
  return import("../lib/agents/lead-agent");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  db.userFindMany.mockImplementation(table([]));
  db.fallbackLeadFindMany.mockImplementation(table([]));
  db.auditLogFindMany.mockResolvedValue([]);
  db.auditLogCreate.mockResolvedValue({});
  wa.isWhatsAppConfigured.mockReturnValue(true);
  wa.sendWhatsAppMessage.mockImplementation(async (jid: string) => ({
    messageId: `wa-${jid}`,
    mocked: false,
  }));
  stubLLM();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("dedup via AuditLog (14-day cooldown)", () => {
  it("looks up LEAD_REENGAGEMENT_SENT rows from the last 14 days", async () => {
    const { runLeadAgent, LEAD_REENGAGEMENT_ACTION } = await loadLeadAgent();

    await runLeadAgent({ now: NOW });

    expect(LEAD_REENGAGEMENT_ACTION).toBe("LEAD_REENGAGEMENT_SENT");
    expect(db.auditLogFindMany).toHaveBeenCalledWith({
      where: {
        action: "LEAD_REENGAGEMENT_SENT",
        createdAt: { gte: new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000) },
      },
      select: { entityId: true, metadata: true },
    });
  });

  it("excludes a lead contacted within 14 days, counts it as skipped, and never messages it", async () => {
    db.auditLogFindMany.mockResolvedValue([
      { entityId: "u-contacted", metadata: { phoneJid: "972541111111@c.us" } },
    ]);
    db.userFindMany.mockImplementation(
      table([userLead("u-contacted", "054-111-1111", hoursAgo(40)), userLead("u-new", "054-222-2222")])
    );
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    const candidateQuery = db.userFindMany.mock.calls[0][0] as FindManyArgs;
    expect(candidateQuery.where.id).toEqual({ notIn: ["u-contacted"] });
    expect(result.skipped).toContainEqual({ leadId: "u-contacted", reason: "ALREADY_CONTACTED" });
    expect(result).toMatchObject({ sentCount: 1, failedCount: 0, skippedCount: 1 });
    expect(wa.sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(wa.sendWhatsAppMessage.mock.calls[0][0]).toBe("972542222222@c.us");
  });

  it("does not let contacted leads use up the per-run cap", async () => {
    const { MAX_LEADS_PER_RUN, runLeadAgent } = await loadLeadAgent();
    const contacted = Array.from({ length: MAX_LEADS_PER_RUN }, (_, i) =>
      userLead(`old-${i}`, `05411${String(i).padStart(5, "0")}`, hoursAgo(47))
    );
    db.auditLogFindMany.mockResolvedValue(contacted.map((u) => ({ entityId: u.id, metadata: {} })));
    db.userFindMany.mockImplementation(table([...contacted, userLead("fresh", "052-999-8888")]));

    const result = await runLeadAgent({ now: NOW });

    expect(result.sent.map((s) => s.leadId)).toEqual(["fresh"]);
    expect(result.skippedCount).toBe(MAX_LEADS_PER_RUN);
  });

  it("treats a different lead record with an already-messaged phone as contacted", async () => {
    db.auditLogFindMany.mockResolvedValue([
      { entityId: "u-registered", metadata: { phoneJid: "972543333333@c.us" } },
    ]);
    db.fallbackLeadFindMany.mockImplementation(table([fallbackLead("f-same-phone", "0543333333")]));
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result.skipped).toEqual([{ leadId: "f-same-phone", reason: "ALREADY_CONTACTED" }]);
    expect(wa.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("caps each run between 10 and 15 leads", async () => {
    const { MAX_LEADS_PER_RUN, runLeadAgent } = await loadLeadAgent();
    expect(MAX_LEADS_PER_RUN).toBeGreaterThanOrEqual(10);
    expect(MAX_LEADS_PER_RUN).toBeLessThanOrEqual(15);
    db.userFindMany.mockImplementation(
      table(Array.from({ length: 30 }, (_, i) => userLead(`u${i}`, `05260${String(i).padStart(5, "0")}`)))
    );
    db.fallbackLeadFindMany.mockImplementation(
      table(Array.from({ length: 30 }, (_, i) => fallbackLead(`f${i}`, `05270${String(i).padStart(5, "0")}`)))
    );

    const result = await runLeadAgent({ now: NOW });

    expect((db.userFindMany.mock.calls[0][0] as FindManyArgs).take).toBe(MAX_LEADS_PER_RUN);
    expect(result.processedCount).toBe(MAX_LEADS_PER_RUN);
    expect(wa.sendWhatsAppMessage).toHaveBeenCalledTimes(MAX_LEADS_PER_RUN);
  });
});

describe("live WhatsApp dispatch + AuditLog", () => {
  it("sends the drafted message and records LEAD_REENGAGEMENT_SENT with messageId and timestamp", async () => {
    db.userFindMany.mockImplementation(table([userLead("u1", "054-123-4567")]));
    db.fallbackLeadFindMany.mockImplementation(table([fallbackLead("f1", "0521112233")]));
    const { runLeadAgent, OPT_OUT_LINE } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result).toMatchObject({ processedCount: 2, sentCount: 2, failedCount: 0, skippedCount: 0 });
    expect(wa.sendWhatsAppMessage).toHaveBeenCalledWith(
      "972541234567@c.us",
      `${LLM_TEXT}\n\n${OPT_OUT_LINE}`,
      { timeoutMs: 5_000 }
    );

    const records = auditCreates();
    expect(records).toHaveLength(2);
    const userRecord = records.find((r) => r.entityId === "u1");
    expect(userRecord).toMatchObject({
      action: "LEAD_REENGAGEMENT_SENT",
      entityType: "User",
      entityId: "u1",
      actorId: null,
      metadata: {
        agent: "lead-agent",
        source: "user",
        phoneJid: "972541234567@c.us",
        messageId: "wa-972541234567@c.us",
      },
    });
    expect(new Date(String(userRecord?.metadata.sentAt)).toISOString()).toBe(userRecord?.metadata.sentAt);
    expect(records.find((r) => r.entityId === "f1")).toMatchObject({
      entityType: "FallbackLead",
      metadata: { source: "fallback_lead", phoneJid: "972521112233@c.us" },
    });
  });

  it("returns the sent leads with their provider message ids", async () => {
    db.userFindMany.mockImplementation(table([userLead("u1", "054-123-4567")]));
    const { runLeadAgent } = await loadLeadAgent();

    const { sent } = await runLeadAgent({ now: NOW });

    expect(sent).toEqual([
      { leadId: "u1", source: "user", phoneJid: "972541234567@c.us", messageId: "wa-972541234567@c.us" },
    ]);
  });
});

describe("per-lead failure isolation", () => {
  it("counts a failed send, keeps processing the rest, and writes no AuditLog for the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.userFindMany.mockImplementation(
      table([
        userLead("u-ok-1", "054-100-0001", hoursAgo(30)),
        userLead("u-broken", "054-100-0002", hoursAgo(20)),
        userLead("u-ok-2", "054-100-0003", hoursAgo(10)),
      ])
    );
    wa.sendWhatsAppMessage.mockImplementation(async (jid: string) => {
      if (jid === "972541000002@c.us") throw new Error("WhatsApp sendMessage failed (502)");
      return { messageId: `wa-${jid}`, mocked: false };
    });
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result).toMatchObject({ processedCount: 3, sentCount: 2, failedCount: 1, skippedCount: 0 });
    expect(result.failed).toEqual([{ leadId: "u-broken", source: "user", reason: "WHATSAPP_ERROR" }]);
    expect(wa.sendWhatsAppMessage).toHaveBeenCalledTimes(3);
    expect(auditCreates().map((r) => r.entityId).sort()).toEqual(["u-ok-1", "u-ok-2"]);
  });

  it("does not record a send when the gateway only mocked it", async () => {
    db.userFindMany.mockImplementation(table([userLead("u1", "054-123-4567")]));
    wa.sendWhatsAppMessage.mockResolvedValue({ messageId: null, mocked: true });
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result.failed).toEqual([{ leadId: "u1", source: "user", reason: "WHATSAPP_NOT_DELIVERED" }]);
    expect(db.auditLogCreate).not.toHaveBeenCalled();
  });

  it("skips drafting and sending entirely when WhatsApp is not configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    wa.isWhatsAppConfigured.mockReturnValue(false);
    db.userFindMany.mockImplementation(table([userLead("u1", "054-123-4567")]));
    const fetchMock = stubLLM();
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result).toMatchObject({ processedCount: 0, sentCount: 0, skippedCount: 1 });
    expect(result.skipped).toEqual([{ leadId: "u1", reason: "WHATSAPP_NOT_CONFIGURED" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wa.sendWhatsAppMessage).not.toHaveBeenCalled();
  });

  it("still reports a delivered message as sent when the AuditLog write fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.userFindMany.mockImplementation(table([userLead("u1", "054-123-4567")]));
    db.auditLogCreate.mockRejectedValue(new Error("db down"));
    const { runLeadAgent } = await loadLeadAgent();

    const result = await runLeadAgent({ now: NOW });

    expect(result).toMatchObject({ sentCount: 1, failedCount: 0 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("not protected by the cooldown"),
      expect.any(Error)
    );
  });
});
