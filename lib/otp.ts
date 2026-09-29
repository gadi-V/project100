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

function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

type SmsProviderResult = { ok: boolean; provider: string };

async function sendViaTwilio(phone: string, message: string): Promise<SmsProviderResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const from = process.env.TWILIO_FROM_NUMBER?.trim();

  if (!accountSid || !authToken || !from) {
    throw new Error("Twilio env not configured");
  }

  const to = normalizeToE164(phone);
  const body = new URLSearchParams({ To: to, From: from, Body: message });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`Twilio SMS failed (${response.status}): ${detail}`);
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
    throw new Error("Generic SMS API env not configured");
  }

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone, message }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`SMS API failed (${response.status}): ${detail}`);
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
      console.error("SMS OTP delivery failed");
      throw error;
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

  throw new Error("No SMS provider configured for production");
}
