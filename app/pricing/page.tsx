"use client";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Testimonials from "../../components/Testimonials";
import BenefitsBar from "../../components/landing/BenefitsBar";
import PricingPlans, { PACKAGES } from "../../components/pricing/PricingPlans";
import { frostCard, pageCanvas } from "../../lib/ui";

const FAQS = [
  {
    question: "לאיזה מקצועות ורמות השיעורים מתאימים?",
    answer:
      "לכל המקצועות והחומרים! אנחנו מכסים את כל חומרי הלימוד: ממקצועות בית הספר ועד לקורסים אקדמיים מורכבים.",
  },
  {
    question: "האם צריך להתחייב למסלול ארוך?",
    answer:
      "ממש לא. אין אצלנו התחייבויות לטווח ארוך או דמי מנוי. אתם רוכשים חבילת קרדיטים גמישה שמתאימה בדיוק לצרכים שלכם.",
  },
  {
    question: "איך עובדת מעטפת התמיכה בין השיעורים?",
    answer:
      "אם נתקעתם עם תרגיל או מטלה – אתם לא לבד. המערכת כוללת מענה בוואטסאפ לקבלת הכוונה מהירה מהצוות.",
  },
  {
    question: "איך מתבצעת התאמת המורה או המרצה?",
    answer:
      "לפני שמתחילים, אנחנו עושים מיפוי קצר של הצרכים שלכם. המערכת מתאימה את איש המקצוע המדויק ביותר מתוך הנבחרת.",
  },
];

/** Only allow same-origin relative paths (open-redirect safe). */
function sanitizeReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return null;
  if (decoded.startsWith("/login") || decoded.startsWith("/register")) return null;
  return decoded;
}

function PricingPageInner() {
  const searchParams = useSearchParams();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const packageFromUrl = searchParams.get("package");
  const quizIdFromUrl = searchParams.get("quizId");
  const returnUrl = useMemo(
    () => sanitizeReturnUrl(searchParams.get("returnUrl")),
    [searchParams]
  );

  const highlightedPackageId = useMemo(() => {
    if (packageFromUrl && PACKAGES.some((p) => p.id === packageFromUrl)) {
      return packageFromUrl;
    }
    return null;
  }, [packageFromUrl]);

  const resumePath = (packageId: string): string => {
    const params = new URLSearchParams();
    params.set("package", packageId);
    if (quizIdFromUrl) params.set("quizId", quizIdFromUrl);
    if (returnUrl) params.set("returnUrl", returnUrl);
    return `/pricing?${params.toString()}`;
  };

  return (
    <div className={`${pageCanvas} py-16 px-4 sm:px-6`} dir="rtl">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-3xl mx-auto mb-16 space-y-4">
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-neutral-900 [text-wrap:balance]">
            כל המקצועות. כל החומרים. הבנה מלאה.
          </h1>
          <p className="text-lg text-neutral-500">
            מתלמידי חטיבה ותיכון ועד לסטודנטים באקדמיה. חבילות קרדיטים גמישות ללא התחייבות.
          </p>
          {quizIdFromUrl && (
            <p className="text-sm font-medium text-neutral-700 bg-white/70 border border-neutral-200 rounded-xl inline-block px-4 py-2">
              לאחר הרכישה תחזרו אוטומטית לדו״ח האבחון המלא
            </p>
          )}
        </div>

        <BenefitsBar className="mb-12" />

        <PricingPlans
          className="mb-28"
          highlightedPackageId={highlightedPackageId}
          quizId={quizIdFromUrl}
          returnUrl={returnUrl}
          resumePath={resumePath}
        />

        <Testimonials />

        <div className="max-w-3xl mx-auto border-t border-neutral-200/80 pt-16" id="faq">
          <div className="text-center mb-10 space-y-2">
            <h2 className="text-3xl font-semibold tracking-tight text-neutral-900">שאלות נפוצות</h2>
            <p className="text-neutral-500 text-sm">כל מה שחשוב לדעת על החבילות והמעטפת</p>
          </div>

          <div className="space-y-4">
            {FAQS.map((faq, index) => {
              const isOpen = openFaq === index;
              return (
                <div key={index} className={`${frostCard} overflow-hidden`}>
                  <button
                    onClick={() => setOpenFaq(isOpen ? null : index)}
                    className="w-full flex items-center justify-between p-5 text-start font-medium text-neutral-800 hover:text-neutral-900 transition-colors"
                  >
                    <span>{faq.question}</span>
                    <span
                      className={`text-xl text-neutral-500 transition-transform duration-200 ${
                        isOpen ? "rotate-45" : ""
                      }`}
                    >
                      ＋
                    </span>
                  </button>

                  <div
                    className={`transition-all duration-300 ease-in-out ${
                      isOpen
                        ? "max-h-48 border-t border-neutral-200/60 p-5 text-neutral-600 bg-white/30"
                        : "max-h-0 overflow-hidden"
                    }`}
                  >
                    <p className="text-sm leading-relaxed text-start">{faq.answer}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PricingPage() {
  return (
    <Suspense
      fallback={
        <div className={`${pageCanvas} py-16 px-4`} dir="rtl">
          <div className="max-w-3xl mx-auto text-center text-neutral-500 text-sm font-medium">
            טוען חבילות...
          </div>
        </div>
      }
    >
      <PricingPageInner />
    </Suspense>
  );
}
