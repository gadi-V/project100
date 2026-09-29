/**
 * Central phone normalization for outbound SMS (Twilio) and WhatsApp.
 * Local Israeli numbers (05X-XXX-XXXX) are mapped to E.164 (+972XXXXXXXXX).
 */

const ISRAEL_COUNTRY_CODE = "972";
const MIN_DIGITS = 9;
const MAX_DIGITS = 15;
/** Israeli national significant number: 8 digits (landline) or 9 digits (mobile). */
const ISRAEL_NATIONAL_LENGTH = /^\d{8,9}$/;

export class InvalidPhoneNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPhoneNumberError";
  }
}

/**
 * Normalize a phone number to E.164 (`+972541234567`).
 * Throws `InvalidPhoneNumberError` when the input cannot form a valid number.
 */
export function normalizeToE164(phone: string): string {
  const cleaned = (phone ?? "").replace(/[^\d+]/g, "");
  const hasPlus = cleaned.startsWith("+");
  let digits = cleaned.replace(/\+/g, "");

  if (!digits) {
    throw new InvalidPhoneNumberError("Phone number is empty");
  }

  if (!hasPlus && digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (!hasPlus && digits.startsWith("0")) {
    digits = ISRAEL_COUNTRY_CODE + digits.slice(1);
  }

  if (digits.startsWith(ISRAEL_COUNTRY_CODE)) {
    const national = digits.slice(ISRAEL_COUNTRY_CODE.length).replace(/^0+/, "");
    if (!ISRAEL_NATIONAL_LENGTH.test(national)) {
      throw new InvalidPhoneNumberError(
        `Invalid Israeli phone number: expected 8-9 national digits, got ${national.length}`
      );
    }
    digits = ISRAEL_COUNTRY_CODE + national;
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    throw new InvalidPhoneNumberError(
      `Invalid phone number: expected ${MIN_DIGITS}-${MAX_DIGITS} digits, got ${digits.length}`
    );
  }

  return `+${digits}`;
}

/** WhatsApp personal chat id: `972541234567@c.us`. */
export function normalizeToWhatsAppJid(phone: string): string {
  return `${normalizeToE164(phone).slice(1)}@c.us`;
}
