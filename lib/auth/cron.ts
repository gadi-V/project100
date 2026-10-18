import { base64url, jwtVerify } from "jose";
import { timingSafeEqualString } from "../hive-m2m-auth";

/**
 * Validates `Authorization: Bearer <CRON_SECRET>` — the header Vercel Cron sends
 * automatically and the QStash schedules forward (scripts/setup-qstash-schedules.ts).
 * Fails closed when CRON_SECRET is unset.
 */
export function verifyCronAuth(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error("[CRON_AUTH] Missing CRON_SECRET environment variable.");
    return false;
  }

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  if (!token) return false;

  return timingSafeEqualString(cronSecret, token);
}

/**
 * Verifies the `Upstash-Signature` JWT that QStash attaches to every delivery.
 * The header alone proves nothing — it must verify against a signing key, match
 * the request body hash, and target this route's path and query.
 */
export async function verifyQStashSignature(req: Request): Promise<boolean> {
  const signature = req.headers.get("upstash-signature");
  if (!signature) return false;

  const signingKeys = [
    process.env.QSTASH_CURRENT_SIGNING_KEY,
    process.env.QSTASH_NEXT_SIGNING_KEY,
  ]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));
  if (signingKeys.length === 0) {
    console.error(
      "[CRON_AUTH] upstash-signature received but QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not set."
    );
    return false;
  }

  try {
    const body = await req.clone().text();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const bodyHash = base64url.encode(new Uint8Array(digest));
    const requestTarget = targetOf(req.url);
    if (!requestTarget) return false;

    // Both keys are tried so signing-key rotation in the Upstash console never drops a delivery.
    for (const key of signingKeys) {
      try {
        const { payload } = await jwtVerify(signature, new TextEncoder().encode(key), {
          issuer: "Upstash",
          algorithms: ["HS256"],
          clockTolerance: 5,
        });
        const claimedBody = typeof payload.body === "string" ? payload.body.replace(/=+$/, "") : "";
        if (claimedBody !== bodyHash) continue;
        // Host is ignored (Vercel rewrites it). Path and query must match, so a
        // signature for one job cannot be replayed against another.
        if (typeof payload.sub !== "string" || targetOf(payload.sub) !== requestTarget) continue;
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    console.error("[CRON_AUTH] QStash signature verification failed.");
    return false;
  }
}

/** Single entry point for cron route handlers: CRON_SECRET bearer, or a verified QStash signature. */
export async function verifyCronRequest(req: Request): Promise<boolean> {
  if (verifyCronAuth(req)) return true;
  return verifyQStashSignature(req);
}

/** Path plus query, without host. Returns null when `url` is not absolute. */
function targetOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
