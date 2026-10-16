import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

type EventRow = {
  id: string;
  externalId: string;
  processed: boolean;
  error: string | null;
  createdAt: Date;
};

const db = vi.hoisted(() => ({
  events: new Map<string, EventRow>(),
  payments: [] as Array<{ transactionId: string; creditsAdded: number }>,
  ledger: [] as string[],
  credits: 0,
  userUpdates: 0,
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    webhookEvent: {
      findUnique: async ({ where }: { where: { externalId: string } }) =>
        db.events.get(where.externalId) ?? null,
      create: async ({
        data,
      }: {
        data: { externalId: string; eventType: string; provider: string; payload: object; processed: boolean };
      }) => {
        if (db.events.has(data.externalId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row: EventRow = {
          id: `wh-${data.externalId}`,
          externalId: data.externalId,
          processed: false,
          error: null,
          createdAt: new Date(),
        };
        db.events.set(data.externalId, row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { processed?: boolean; processedAt?: Date; error?: string | null };
      }) => {
        const row = [...db.events.values()].find((event) => event.id === where.id);
        if (!row) throw new Error("missing webhook row");
        if (data.processed !== undefined) row.processed = data.processed;
        if ("error" in data) row.error = data.error ?? null;
        return row;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        payment: {
          findFirst: async ({ where }: { where: { transactionId: string } }) =>
            db.payments.find((payment) => payment.transactionId === where.transactionId) ?? null,
          create: async ({
            data,
          }: {
            data: { transactionId: string; creditsAdded: number; studentId: string };
          }) => {
            const payment = { id: `pay-${data.transactionId}`, ...data };
            db.payments.push(payment);
            return payment;
          },
        },
        billingLedger: {
          findUnique: async ({ where }: { where: { transactionId: string } }) =>
            db.ledger.includes(where.transactionId) ? { id: where.transactionId } : null,
          create: async ({ data }: { data: { transactionId: string } }) => {
            if (db.ledger.includes(data.transactionId)) {
              throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            }
            db.ledger.push(data.transactionId);
            return { id: `led-${data.transactionId}` };
          },
        },
        user: {
          update: async ({ data }: { data: { lessonCredits: { increment: number } } }) => {
            db.userUpdates += 1;
            db.credits += data.lessonCredits.increment;
            return { lessonCredits: db.credits };
          },
        },
      };
      return fn(tx);
    },
  },
}));

const WEBHOOK_SECRET = "whsec_test_secret";
const stripe = new Stripe("sk_test_webhook_unit");

function signedRequest(event: object): Request {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return new Request("https://project100.example/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body: payload,
  });
}

function checkoutEvent(id = "evt_checkout_1") {
  return {
    id,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        payment_status: "paid",
        payment_intent: "pi_1",
        amount_total: 54000,
        client_reference_id: "student-1",
        metadata: {
          userId: "student-1",
          packageType: "TRIO",
          credits: "3",
          amountPaid: "540",
        },
      },
    },
  };
}

function paymentIntentEvent(id = "evt_pi_1") {
  return {
    id,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_1",
        object: "payment_intent",
        status: "succeeded",
        amount: 54000,
        amount_received: 54000,
        metadata: {
          userId: "student-1",
          packageType: "TRIO",
          credits: "3",
          amountPaid: "540",
        },
      },
    },
  };
}

async function postWebhook(request: Request) {
  const { POST } = await import("../app/api/webhooks/stripe/route");
  return POST(request);
}

beforeEach(() => {
  vi.resetModules();
  db.events.clear();
  db.payments.length = 0;
  db.ledger.length = 0;
  db.credits = 0;
  db.userUpdates = 0;
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_webhook_unit");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/stripe", () => {
  it("rejects a missing or invalid signature before any credit", async () => {
    const missing = await postWebhook(
      new Request("https://project100.example/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify(checkoutEvent()),
      })
    );
    expect(missing.status).toBe(401);

    const forged = await postWebhook(
      new Request("https://project100.example/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef" },
        body: JSON.stringify(checkoutEvent()),
      })
    );
    expect(forged.status).toBe(401);
    expect(db.credits).toBe(0);
    expect(db.payments).toHaveLength(0);
  });

  it("fails closed when the webhook secret is unset", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    const response = await postWebhook(signedRequest(checkoutEvent()));
    expect(response.status).toBe(503);
    expect(db.credits).toBe(0);
  });

  it("credits a checkout once and ignores a second delivery of the same event id", async () => {
    const first = await postWebhook(signedRequest(checkoutEvent()));
    const second = await postWebhook(signedRequest(checkoutEvent()));

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, duplicate: true });
    expect(db.credits).toBe(3);
    expect(db.userUpdates).toBe(1);
    expect(db.payments.map((payment) => payment.transactionId)).toEqual(["pi_1"]);
    expect(db.ledger).toEqual(["pi_1"]);
  });

  it("credits payment_intent.succeeded once when Stripe retries that event", async () => {
    const first = await postWebhook(signedRequest(paymentIntentEvent()));
    const second = await postWebhook(signedRequest(paymentIntentEvent()));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(db.credits).toBe(3);
    expect(db.userUpdates).toBe(1);
  });

  it("does not credit again when checkout and payment_intent share a payment intent", async () => {
    const checkout = await postWebhook(signedRequest(checkoutEvent("evt_checkout_shared")));
    const intent = await postWebhook(signedRequest(paymentIntentEvent("evt_pi_shared")));

    expect(checkout.status).toBe(200);
    expect(intent.status).toBe(200);
    expect(db.credits).toBe(3);
    expect(db.userUpdates).toBe(1);
    expect(db.payments).toHaveLength(1);
    expect(db.ledger).toEqual(["pi_1"]);
  });

  it("does not credit while another delivery of the same event is still in progress", async () => {
    db.events.set("evt_checkout_1", {
      id: "wh-inflight",
      externalId: "evt_checkout_1",
      processed: false,
      error: null,
      createdAt: new Date(),
    });

    const response = await postWebhook(signedRequest(checkoutEvent()));

    expect(response.status).toBe(503);
    expect(db.credits).toBe(0);
    expect(db.userUpdates).toBe(0);
  });
});
