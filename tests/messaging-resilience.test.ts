import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "super-secret-gateway-token";
const TWILIO_CODE = "21211";
const TWILIO_TOKEN = "twilio-auth-token-value";

const db = vi.hoisted(() => ({
  user: null as { id: string } | null,
  otpCreates: 0,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async () => db.user,
    },
    otpCode: {
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        db.otpCreates += 1;
        return { id: "otp-1" };
      },
    },
  },
}));

import { SmsDeliveryError, sendSmsOtp } from "../lib/otp";
import { sendWhatsAppMessage } from "../lib/whatsapp";

function loggedText(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((args) => args.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "))
    .join("\n");
}

beforeEach(() => {
  db.user = null;
  db.otpCreates = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WhatsApp gateway failures", () => {
  beforeEach(() => {
    vi.stubEnv("WHATSAPP_API_URL", `https://gateway.example/${SECRET}`);
    vi.stubEnv("WHATSAPP_API_KEY", SECRET);
  });

  it("rejects a gateway error without the response body or the api key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`token=${SECRET} code=131026`, { status: 401 }))
    );

    await expect(sendWhatsAppMessage("0541234567", "hi")).rejects.toThrow(
      "WhatsApp sendMessage failed (401)"
    );

    const logs = loggedText();
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain("131026");
    expect(logs).toContain("gateway rejected the message");
  });

  it("turns a timeout into a status-only error and does not leak the gateway url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException(`timed out contacting https://gateway.example/${SECRET}`, "TimeoutError");
      })
    );

    await expect(sendWhatsAppMessage("0541234567", "hi")).rejects.toThrow(/timed out after/);
    expect(loggedText()).not.toContain(SECRET);
  });

  it("turns a network failure into a status-only error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`connect ECONNREFUSED https://gateway.example/${SECRET}`);
      })
    );

    await expect(sendWhatsAppMessage("0541234567", "hi")).rejects.toThrow(
      "WhatsApp sendMessage request failed"
    );
    expect(loggedText()).not.toContain(SECRET);
  });

  it("keeps the mock path when the gateway token is missing", async () => {
    vi.stubEnv("WHATSAPP_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendWhatsAppMessage("0541234567", "hi")).resolves.toEqual({
      messageId: null,
      mocked: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Twilio OTP delivery", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", TWILIO_TOKEN);
    vi.stubEnv("TWILIO_FROM_NUMBER", "+972500000099");
  });

  it("throws a generic delivery error and drops the Twilio payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: Number(TWILIO_CODE),
              message: "Invalid 'To' Phone Number",
              more_info: `https://www.twilio.com/docs/errors/${TWILIO_CODE}`,
              token: TWILIO_TOKEN,
            }),
            { status: 400 }
          )
      )
    );

    const error = await sendSmsOtp("0541234567", "123456").then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(SmsDeliveryError);
    expect(error).toMatchObject({ message: "SMS_DELIVERY_FAILED", status: 400 });
    expect(String(error)).not.toContain(TWILIO_CODE);
    expect(String(error)).not.toContain(TWILIO_TOKEN);
    expect(loggedText()).not.toContain(TWILIO_CODE);
    expect(loggedText()).not.toContain(TWILIO_TOKEN);
    expect(loggedText()).toContain("twilio");
  });

  it("returns a generic client error after the OTP row is stored", async () => {
    db.user = { id: "user-1" };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: Number(TWILIO_CODE), message: "Invalid 'To'" }), {
            status: 400,
          })
      )
    );
    const { POST } = await import("../app/api/auth/forgot-password/route");

    const response = await POST(
      new Request("https://project100.example/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "0541234567" }),
      })
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: "שליחת קוד האימות נכשלה. נסו שוב מאוחר יותר." });
    expect(serialized).not.toContain(TWILIO_CODE);
    expect(serialized).not.toContain("Twilio");
    expect(serialized).not.toContain(TWILIO_TOKEN);
    expect(db.otpCreates).toBe(1);
  });

  it("does not send and keeps the uniform reply when the phone is unknown", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../app/api/auth/forgot-password/route");

    const response = await POST(
      new Request("https://project100.example/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "0541234567" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.otpCreates).toBe(0);
  });
});
