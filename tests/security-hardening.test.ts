import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InvalidPhoneNumberError,
  normalizeToE164,
  normalizeToWhatsAppJid,
} from "../lib/utils/phone";
import {
  STREAM_PHONE_BLOCK_PATTERNS,
  censorChatText,
  moderateChatText,
} from "../lib/chat-moderation";
import { computeDailyTokenWindow, generateDailyToken } from "../lib/daily";
import { STREAM_TOKEN_TTL_SECONDS, generateStreamToken } from "../lib/stream";
import { sendWhatsAppText } from "../lib/whatsapp";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("normalizeToE164", () => {
  it.each([
    ["0541234567", "+972541234567"],
    ["054-123-4567", "+972541234567"],
    ["054 123 4567", "+972541234567"],
    ["(054) 123-4567", "+972541234567"],
    ["054.123.4567", "+972541234567"],
    ["+972541234567", "+972541234567"],
    ["+972 54-123-4567", "+972541234567"],
    ["972541234567", "+972541234567"],
    ["+9720541234567", "+972541234567"],
    ["9720541234567", "+972541234567"],
    ["+972 (0)54 123 4567", "+972541234567"],
    ["00972541234567", "+972541234567"],
    ["03-1234567", "+97231234567"],
    ["+1 (415) 555-2671", "+14155552671"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeToE164(input)).toBe(expected);
  });

  it.each(["", "abc", "12345", "054-123", "0000000000", "+9725412345678901", "+1234567890123456"])(
    "rejects invalid input %j",
    (input) => {
      expect(() => normalizeToE164(input)).toThrow(InvalidPhoneNumberError);
    }
  );
});

describe("normalizeToWhatsAppJid", () => {
  it.each([
    ["0541234567", "972541234567@c.us"],
    ["054-123-4567", "972541234567@c.us"],
    ["+972 54 123 4567", "972541234567@c.us"],
    ["972541234567", "972541234567@c.us"],
    ["+9720541234567", "972541234567@c.us"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeToWhatsAppJid(input)).toBe(expected);
  });

  it("throws on invalid numbers", () => {
    expect(() => normalizeToWhatsAppJid("0000000000")).toThrow(InvalidPhoneNumberError);
  });
});

describe("sendWhatsAppText recipient normalization", () => {
  it("sends the E.164 digits and a @c.us chat id for a local number", async () => {
    vi.stubEnv("WHATSAPP_API_URL", "https://wa.example.test");
    vi.stubEnv("WHATSAPP_API_KEY", "key");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendWhatsAppText("054-123-4567", "hi");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      phone: "972541234567",
      chatId: "972541234567@c.us",
    });
  });
});

describe("moderateChatText", () => {
  it.each([
    ["+972541234567", "phone"],
    ["054.123.4567", "phone"],
    ["(054)1234567", "phone"],
    ["(054) 123-4567", "phone"],
    ["0 5 4 1 2 3 4 5 6 7", "phone"],
    ["00972 54 123 4567", "phone"],
    ["972-54-123-4567", "phone"],
    ["+972 (0)54 123 4567", "phone"],
    ["03-123-4567", "phone"],
    ["wa.me/972541234567", "external_link"],
    ["https://t.me/example", "external_link"],
    ["www.example.com", "external_link"],
    ["chat.whatsapp.com/AbCdEf", "external_link"],
    ["instagram: @tutor", "social_handle"],
    ["IG:tutor_il", "social_handle"],
    ["tiktok: tutor.il", "social_handle"],
    ["facebook: tutor", "social_handle"],
    ["תעקוב אחרי @tutor123", "social_handle"],
    ["tutor@example.com", "email"],
  ])("blocks %j", (input, violation) => {
    const result = moderateChatText(`דברו איתי: ${input} תודה`);
    expect(result.isClean).toBe(false);
    expect(result.detectedViolations).toContain(violation);
    expect(result.censoredText).not.toContain(input);
    expect(result.censoredText).toMatch(/^דברו איתי: .*צונזר.* תודה$/);
  });

  it("does not leak digits of an embedded phone inside a link", () => {
    const { censoredText } = moderateChatText("wa.me/972541234567");
    expect(censoredText).not.toMatch(/\d/);
  });

  it.each([
    "נתראה ב-05.07.2026 10:30",
    "השיעור ב-03/07/2026 בשעה 18:00",
    "x = 3.14 ו-y = 0.5",
    "פתרנו 12 תרגילים מתוך 20",
    "קראתי את זה באינסטגרם אתמול",
  ])("leaves ordinary lesson chat untouched: %j", (input) => {
    expect(moderateChatText(input)).toEqual({
      isClean: true,
      censoredText: input,
      detectedViolations: [],
    });
  });

  it("censorChatText stays aligned with moderateChatText", () => {
    const text = "0541234567 או https://t.me/x";
    expect(censorChatText(text)).toBe(moderateChatText(text).censoredText);
  });

  it("is safe to call repeatedly (no stale global regex state)", () => {
    for (let i = 0; i < 3; i++) {
      expect(moderateChatText("+972541234567").isClean).toBe(false);
    }
  });
});

describe("Stream server phone blocklist patterns", () => {
  const matchesAny = (text: string) =>
    STREAM_PHONE_BLOCK_PATTERNS.some((p) => new RegExp(p).test(text));

  it.each(["+972541234567", "054.123.4567", "(054)1234567", "0 5 4 1 2 3 4 5 6 7", "03-1234567"])(
    "blocks %j",
    (text) => {
      expect(matchesAny(text)).toBe(true);
    }
  );

  it("does not block a date followed by a clock time", () => {
    expect(matchesAny("נתראה ב-05.07.2026 10:30")).toBe(false);
  });
});

describe("Daily token window", () => {
  const scheduledAt = new Date("2026-10-01T15:00:00.000Z");
  const startSec = scheduledAt.getTime() / 1000;

  it("opens 15 minutes before start and closes 30 minutes after the lesson ends", () => {
    expect(computeDailyTokenWindow(scheduledAt, 60)).toEqual({
      nbf: startSec - 15 * 60,
      exp: startSec + (60 + 30) * 60,
    });
  });

  it("defaults to a 60-minute lesson and scales with longer lessons", () => {
    expect(computeDailyTokenWindow(scheduledAt).exp).toBe(startSec + 90 * 60);
    expect(computeDailyTokenWindow(scheduledAt, 120).exp).toBe(startSec + 150 * 60);
  });

  it("falls back to 60 minutes for a non-positive duration", () => {
    expect(computeDailyTokenWindow(scheduledAt, 0).exp).toBe(startSec + 90 * 60);
  });

  it("rejects an invalid scheduledAt", () => {
    expect(() => computeDailyTokenWindow(new Date("invalid"))).toThrow();
  });

  it("sends nbf/exp in the Daily meeting-token payload", async () => {
    vi.stubEnv("DAILY_API_KEY", "daily-test-key");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ token: "tok" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const token = await generateDailyToken("lesson-abc", false, "user-1", {
      scheduledAt,
      durationMinutes: 45,
    });

    expect(token).toBe("tok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.daily.co/v1/meeting-tokens");
    const { properties } = JSON.parse(String(init.body)) as {
      properties: Record<string, unknown>;
    };
    expect(properties).toMatchObject({
      room_name: "lesson-abc",
      user_id: "user-1",
      is_owner: false,
      nbf: startSec - 15 * 60,
      exp: startSec + (45 + 30) * 60,
    });
  });
});

describe("Stream token expiry", () => {
  it("issues a JWT that expires 4 hours after creation", () => {
    vi.stubEnv("STREAM_API_KEY", "stream-test-key");
    vi.stubEnv("STREAM_API_SECRET", "stream-test-secret");
    const nowSec = Math.floor(Date.now() / 1000);

    const token = generateStreamToken("user-1");
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    ) as { user_id: string; exp: number };

    expect(payload.user_id).toBe("user-1");
    expect(payload.exp).toBeGreaterThanOrEqual(nowSec + STREAM_TOKEN_TTL_SECONDS);
    expect(payload.exp).toBeLessThanOrEqual(nowSec + STREAM_TOKEN_TTL_SECONDS + 5);
  });
});
