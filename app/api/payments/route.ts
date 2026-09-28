import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import Stripe from "stripe";
import { LedgerEntryType } from "@prisma/client";
import { requireAuth } from "../../../lib/api-auth";
import { prisma } from "../../../lib/prisma";
import { writeLedgerEntryInTransaction } from "../../../lib/services/LedgerService";

const PACKAGES: Record<string, { price: number; credits: number; label: string }> = {
  SINGLE: { price: 200, credits: 1, label: "שיעור בודד" },
  TRIO: { price: 540, credits: 3, label: "חבילת 3 שיעורים" },
  MULTI: { price: 850, credits: 5, label: "חבילת 5 שיעורים" },
  TEN: { price: 1600, credits: 10, label: "חבילת 10 שיעורים" },
};

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === "mock") {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key);
}

function isMockStripeMode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return !key || key === "mock";
}

function appBaseUrl(request: Request): string {
  return (
    process.env.APP_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin
  );
}

/** Same-origin relative path only — blocks open redirects. */
function sanitizeAppPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) {
    return fallback;
  }
  if (raw.startsWith("/login") || raw.startsWith("/register")) {
    return fallback;
  }
  return raw;
}

/**
 * Create a Stripe Checkout Session. Credits are granted only via the Stripe webhook
 * after `checkout.session.completed` is verified — never here (except mock/dev mode).
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAuth(["STUDENT"]);
    if (auth.error) return auth.error;

    const body = await request.json();
    const { packageType, successUrl, cancelUrl } = body;

    if (!packageType || typeof packageType !== "string") {
      return NextResponse.json({ error: "סוג חבילה הוא שדה חובה" }, { status: 400 });
    }

    const selectedPackage = PACKAGES[packageType];
    if (!selectedPackage) {
      return NextResponse.json({ error: "סוג חבילה לא תקין" }, { status: 400 });
    }

    const safeSuccessPath = sanitizeAppPath(successUrl, "/dashboard?payment=success");
    const safeCancelPath = sanitizeAppPath(cancelUrl, "/pricing?payment=cancelled");

    // Local / mock Stripe: grant credits immediately instead of Checkout + webhook.
    if (isMockStripeMode()) {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          { error: "מערכת התשלומים אינה מוגדרת. פנו לתמיכה." },
          { status: 503 }
        );
      }

      const transactionId = `mock_${randomUUID()}`;

      const updatedCredits = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({
          data: {
            studentId: auth.user.id,
            packageType,
            amountPaid: selectedPackage.price,
            creditsAdded: selectedPackage.credits,
            transactionId,
            status: "COMPLETED",
          },
        });

        const updatedUser = await tx.user.update({
          where: { id: auth.user.id },
          data: { lessonCredits: { increment: selectedPackage.credits } },
          select: { lessonCredits: true },
        });

        await writeLedgerEntryInTransaction(tx, {
          userId: auth.user.id,
          entryType: LedgerEntryType.CHARGE,
          amount: selectedPackage.price,
          currency: "ILS",
          description: `תשלום מדומה (Dev Mode): ${selectedPackage.label}`,
          relatedId: payment.id,
          transactionId,
          metadata: {
            isMock: true,
            packageType,
            creditsAdded: selectedPackage.credits,
            status: "COMPLETED",
          },
        });

        return updatedUser.lessonCredits;
      });

      return NextResponse.json({
        success: true,
        isMock: true,
        newCredits: updatedCredits,
        redirectUrl: safeSuccessPath,
        message: "תשלום מדומה הושלם בהצלחה",
      });
    }

    const stripe = getStripe();
    const baseUrl = appBaseUrl(request);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "ils",
            unit_amount: selectedPackage.price * 100,
            product_data: {
              name: selectedPackage.label,
              description: `${selectedPackage.credits} קרדיטי שיעור`,
            },
          },
        },
      ],
      success_url: `${baseUrl}${safeSuccessPath}${safeSuccessPath.includes("?") ? "&" : "?"}payment=success`,
      cancel_url: `${baseUrl}${safeCancelPath}${safeCancelPath.includes("?") ? "&" : "?"}payment=cancelled`,
      metadata: {
        userId: auth.user.id,
        packageType,
        credits: String(selectedPackage.credits),
        amountPaid: String(selectedPackage.price),
      },
      client_reference_id: auth.user.id,
    });

    if (!session.url) {
      return NextResponse.json(
        { error: "יצירת סשן תשלום נכשלה" },
        { status: 502 }
      );
    }

    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error: unknown) {
    console.error("Payment API Error:", error);
    return NextResponse.json(
      { error: "שגיאה פנימית בשרת במהלך יצירת התשלום" },
      { status: 500 }
    );
  }
}
