import { NextResponse } from "next/server";
import Stripe from "stripe";
import { LedgerEntryType } from "@prisma/client";
import { prisma } from "../../../../lib/prisma";
import { writeLedgerEntryInTransaction } from "../../../../lib/services/LedgerService";

export const runtime = "nodejs";

/** A crashed worker can be retried after this lease; the ledger unique key still blocks a double credit. */
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

type WebhookClaim =
  | { action: "process"; id: string }
  | { action: "duplicate" }
  | { action: "in_progress" };

/**
 * Claim a Stripe event id exactly once.
 * The unique `WebhookEvent.externalId` is the processed-state record: a second
 * delivery of the same event does not run the credit path again.
 */
async function claimStripeEvent(event: Stripe.Event): Promise<WebhookClaim> {
  try {
    const created = await prisma.webhookEvent.create({
      data: {
        provider: "stripe",
        eventType: event.type,
        externalId: event.id,
        payload: event as object,
        processed: false,
      },
    });
    return { action: "process", id: created.id };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    const existing = await prisma.webhookEvent.findUnique({
      where: { externalId: event.id },
    });
    if (!existing) throw error;
    if (existing.processed) return { action: "duplicate" };

    const createdAt =
      existing.createdAt instanceof Date ? existing.createdAt : new Date(existing.createdAt);
    const ageMs = Date.now() - createdAt.getTime();
    const failed = Boolean(existing.error);
    const stale = Number.isFinite(ageMs) && ageMs >= PROCESSING_LEASE_MS;
    if (!failed && !stale) return { action: "in_progress" };

    await prisma.webhookEvent.update({
      where: { id: existing.id },
      data: { error: null },
    });
    return { action: "process", id: existing.id };
  }
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  const paymentIntent = session.payment_intent;
  if (typeof paymentIntent === "string" && paymentIntent.length > 0) return paymentIntent;
  if (
    paymentIntent &&
    typeof paymentIntent === "object" &&
    "id" in paymentIntent &&
    typeof paymentIntent.id === "string"
  ) {
    return paymentIntent.id;
  }
  return null;
}

function readCredits(raw: string | undefined): number {
  const credits = Number(raw ?? "");
  if (!Number.isInteger(credits) || credits < 1) {
    throw new Error("Invalid credits in Stripe metadata");
  }
  return credits;
}

function readAmountIls(raw: string | undefined, minorUnits: number | null | undefined): number {
  if (raw != null && raw !== "" && Number.isFinite(Number(raw))) {
    return Math.round(Number(raw));
  }
  if (minorUnits != null && Number.isFinite(minorUnits)) {
    return Math.round(minorUnits / 100);
  }
  return 0;
}

type CreditInput = {
  userId: string;
  packageType: string;
  credits: number;
  amountPaid: number;
  transactionId: string;
};

/**
 * Grant package credits once per Stripe payment.
 * `BillingLedger.transactionId` is unique, so a second
 * `checkout.session.completed` or `payment_intent.succeeded` for the same
 * payment intent rolls back instead of incrementing `lessonCredits` again.
 */
async function creditPackageOnce(input: CreditInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const existingPayment = await tx.payment.findFirst({
        where: { transactionId: input.transactionId },
      });
      if (existingPayment) return;

      const existingLedger = await tx.billingLedger.findUnique({
        where: { transactionId: input.transactionId },
      });
      if (existingLedger) return;

      const payment = await tx.payment.create({
        data: {
          studentId: input.userId,
          packageType: input.packageType,
          amountPaid: input.amountPaid,
          creditsAdded: input.credits,
          transactionId: input.transactionId,
          status: "COMPLETED",
        },
      });

      await tx.user.update({
        where: { id: input.userId },
        data: { lessonCredits: { increment: input.credits } },
      });

      await writeLedgerEntryInTransaction(tx, {
        userId: input.userId,
        entryType: LedgerEntryType.CHARGE,
        amount: input.amountPaid,
        currency: "ILS",
        description: `תשלום Stripe: ${input.packageType}`,
        relatedId: payment.id,
        transactionId: input.transactionId,
        metadata: {
          packageType: input.packageType,
          creditsAdded: input.credits,
          status: "COMPLETED",
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  if (session.payment_status !== "paid") return;

  const userId =
    session.metadata?.userId ||
    (typeof session.client_reference_id === "string" ? session.client_reference_id : null);

  if (!userId) {
    throw new Error("checkout.session.completed missing userId metadata");
  }

  const transactionId = paymentIntentId(session) ?? session.id;
  await creditPackageOnce({
    userId,
    packageType: session.metadata?.packageType ?? "UNKNOWN",
    credits: readCredits(session.metadata?.credits),
    amountPaid: readAmountIls(session.metadata?.amountPaid, session.amount_total),
    transactionId,
  });
}

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
  if (intent.status !== "succeeded") return;

  const userId = intent.metadata?.userId;
  if (!userId) {
    console.error("Stripe payment_intent.succeeded has no user metadata; checkout session remains the credit source", {
      eventObjectId: intent.id,
    });
    return;
  }

  await creditPackageOnce({
    userId,
    packageType: intent.metadata?.packageType ?? "UNKNOWN",
    credits: readCredits(intent.metadata?.credits),
    amountPaid: readAmountIls(
      intent.metadata?.amountPaid,
      (intent.amount_received ?? 0) > 0 ? intent.amount_received : intent.amount
    ),
    transactionId: intent.id,
  });
}

/**
 * Stripe webhooks — credit a student only after `STRIPE_WEBHOOK_SECRET` verifies
 * the signature. Event id idempotency is `WebhookEvent.externalId`; payment
 * idempotency is `BillingLedger.transactionId` (the payment intent id).
 */
export async function POST(request: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!webhookSecret || !process.env.STRIPE_SECRET_KEY?.trim()) {
    return NextResponse.json({ error: "Stripe webhook not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature" }, { status: 401 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    console.error("Stripe webhook signature verification failed");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!event.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let claim: WebhookClaim;
  try {
    claim = await claimStripeEvent(event);
  } catch (error) {
    console.error("Stripe webhook claim failed", {
      eventId: event.id,
      message: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json({ ok: false, error: "Webhook handler failed" }, { status: 500 });
  }

  if (claim.action === "duplicate") {
    return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
  }
  if (claim.action === "in_progress") {
    return NextResponse.json({ error: "Webhook is already being processed" }, { status: 503 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    } else if (event.type === "payment_intent.succeeded") {
      await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
    }

    await prisma.webhookEvent.update({
      where: { id: claim.id },
      data: { processed: true, processedAt: new Date(), error: null },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Webhook handler failed";
    console.error("Stripe webhook handler failed", {
      eventId: event.id,
      eventType: event.type,
      message,
    });

    await prisma.webhookEvent
      .update({
        where: { id: claim.id },
        data: { error: message.slice(0, 500) },
      })
      .catch(() => undefined);

    return NextResponse.json({ ok: false, error: "Webhook handler failed" }, { status: 500 });
  }
}
