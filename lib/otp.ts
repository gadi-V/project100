/**
 * Phone + OTP helpers for password reset.
 * Production SMS via Twilio (or compatible REST). Console fallback in development only.
 */

import { normalizeToE164 } from "./utils/phone";

export function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]/g, "").trim();
}

export function generateOtpCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_ATTEMPTS = 5;
const SMS_TIMEOUT_MS = 10_000;

function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

/** Thrown when an SMS provider rejects or cannot be reached. Carries no provider payload. */
export class SmsDeliveryError extends Error {
  readonly status: number | null;

  constructor(status: number | null = null) {
    super("SMS_DELIVERY_FAILED");
    this.name = "SmsDeliveryError";
    this.status = status;
  }
}

function logSmsFailure(provider: string, status?: number): void {
  console.error("SMS delivery failed", { provider, status: status ?? null });
}

type SmsProviderResult = { ok: boolean; provider: string };

async function sendViaTwilio(phone: string, message: string): Promise<SmsProviderResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();

  if (!accountSid || !authToken || !from) {
    throw new SmsDeliveryError();
  }

  const to = normalizeToE164(phone);
  const body = new URLSearchParams({ To: to, From: from, Body: message });

  let response: Response;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      }
    );
  } catch {
    logSmsFailure("twilio");
    throw new SmsDeliveryError();
  }

  if (!response.ok) {
    await response.body?.cancel()?.catch(() => undefined);
    logSmsFailure("twilio", response.status);
    throw new SmsDeliveryError(response.status);
  }

  return { ok: true, provider: "twilio" };
}

async function sendViaGenericSmsApi(
  phone: string,
  message: string
): Promise<SmsProviderResult> {
  const apiUrl = process.env.SMS_API_URL?.trim();
  const apiKey = process.env.SMS_API_KEY?.trim();

  if (!apiUrl || !apiKey) {
    throw new SmsDeliveryError();
  }

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phone, message }),
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
    });
  } catch {
    logSmsFailure("sms_api");
    throw new SmsDeliveryError();
  }

  if (!response.ok) {
    await response.body?.cancel()?.catch(() => undefined);
    logSmsFailure("sms_api", response.status);
    throw new SmsDeliveryError(response.status);
  }

  return { ok: true, provider: "sms_api" };
}

/**
 * Send OTP SMS. Never logs the code or full phone in production.
 * Console fallback is allowed only when NODE_ENV === 'development'.
 */
export async function sendSmsOtp(phone: string, code: string): Promise<void> {
  const message = `קוד האימות שלך לאיפוס סיסמה: ${code}. תקף ל-10 דקות.`;

  const hasTwilio =
    Boolean(process.env.TWILIO_ACCOUNT_SID) &&
    Boolean(process.env.TWILIO_AUTH_TOKEN) &&
    Boolean(process.env.TWILIO_FROM_NUMBER);
  const hasGenericSms =
    Boolean(process.env.SMS_API_URL) && Boolean(process.env.SMS_API_KEY);

  try {
    if (hasTwilio) {
      await sendViaTwilio(phone, message);
      return;
    }
    if (hasGenericSms) {
      await sendViaGenericSmsApi(phone, message);
      return;
    }
  } catch (error) {
    if (!isDevelopment()) {
      if (!(error instanceof SmsDeliveryError)) {
        console.error("SMS OTP delivery failed");
      }
      throw error instanceof SmsDeliveryError ? error : new SmsDeliveryError();
    }
    console.error("SMS OTP delivery failed; falling back to console in development");
  }

  if (isDevelopment()) {
    const masked =
      phone.length > 4 ? `${"*".repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}` : "****";
    console.log("====================================================");
    console.log(`[DEV SMS] Password reset OTP for ${masked}: ${code}`);
    console.log(`[DEV SMS] Valid for 10 minutes`);
    console.log("====================================================");
    return;
  }

  throw new SmsDeliveryError();
}
