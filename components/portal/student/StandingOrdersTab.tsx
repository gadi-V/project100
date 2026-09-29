import {
  formatIls,
  formatIsraelDay,
  STANDING_ORDER_STATUS_LABELS,
  type CardLookup,
  type StandingOrderData,
} from "../../../lib/student-portal-shared";
import { badgeDanger, badgeNeutral, badgeSuccess, badgeWarning, emptyState, eyebrow, frostPanel } from "../../../lib/ui";

type StandingOrdersTabProps = {
  /** null when the viewer may not see billing details. */
  standingOrders: StandingOrderData | null;
};

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  COMPLETED: "שולם",
  PENDING: "ממתין",
  REFUNDED: "הוחזר",
};

const PACKAGE_LABELS: Record<string, string> = {
  SINGLE: "שיעור בודד",
  TRIO: "חבילת 3 שיעורים",
  MULTI: "חבילת 5 שיעורים",
  TEN: "חבילת 10 שיעורים",
};

const STATUS_BADGE: Record<StandingOrderData["status"], string> = {
  ACTIVE: badgeSuccess,
  USED_UP: badgeWarning,
  CANCELLED: badgeDanger,
  NONE: badgeNeutral,
};

function cardText(card: CardLookup): string {
  switch (card.state) {
    case "FOUND":
      return `${card.brand.toUpperCase()} •••• ${card.last4}`;
    case "NO_STRIPE_PAYMENT":
      return "אין כרטיס מקושר";
    case "NOT_CONFIGURED":
      return "החיבור לסליקה לא הוגדר";
    case "UNAVAILABLE":
      return "לא הצלחנו לטעון את פרטי הכרטיס";
  }
}

export default function StandingOrdersTab({ standingOrders }: StandingOrdersTabProps) {
  if (!standingOrders) {
    return (
      <div className={emptyState}>
        <p className="text-sm text-neutral-600">פרטי התשלום זמינים לנציגים ולהנהלה בלבד.</p>
      </div>
    );
  }

  const { status, lessonCredits, card, charges } = standingOrders;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <section className={`${frostPanel} p-5 space-y-2`}>
          <h2 className={eyebrow}>סטטוס מנוי</h2>
          <span className={STATUS_BADGE[status]}>{STANDING_ORDER_STATUS_LABELS[status]}</span>
        </section>
        <section className={`${frostPanel} p-5 space-y-2`}>
          <h2 className={eyebrow}>יתרת שיעורים</h2>
          <p className="text-2xl font-semibold text-neutral-900 tabular-nums">{lessonCredits}</p>
        </section>
        <section className={`${frostPanel} p-5 space-y-2`}>
          <h2 className={eyebrow}>כרטיס אשראי</h2>
          <p className="text-sm font-medium text-neutral-900" dir={card.state === "FOUND" ? "ltr" : undefined}>
            {cardText(card)}
          </p>
        </section>
      </div>
      <p className="text-xs text-neutral-500">התשלום נעשה בחבילות. אין חיוב חודשי אוטומטי.</p>

      <section className={`${frostPanel} overflow-x-auto`} aria-labelledby="charges-title">
        <h2 id="charges-title" className="px-5 py-4 text-sm font-semibold text-neutral-900 border-b border-neutral-100">
          היסטוריית חיובים
        </h2>
        {charges.length === 0 ? (
          <div className={`${emptyState} m-5`}>
            <p className="text-sm text-neutral-600">עדיין אין חיובים.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className="px-5 py-3 text-start font-medium">תאריך</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">חבילה</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">סכום</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">שיעורים</th>
                <th scope="col" className="px-5 py-3 text-start font-medium">מצב</th>
              </tr>
            </thead>
            <tbody>
              {charges.map((charge) => (
                <tr key={charge.id} className="border-b border-neutral-100 last:border-b-0">
                  <td className="px-5 py-3 text-neutral-800">{formatIsraelDay(charge.createdAt)}</td>
                  <td className="px-5 py-3 text-neutral-800">{PACKAGE_LABELS[charge.packageType] ?? charge.packageType}</td>
                  <td className="px-5 py-3 text-neutral-800 tabular-nums">{formatIls(charge.amountPaid)}</td>
                  <td className="px-5 py-3 text-neutral-800 tabular-nums">{charge.creditsAdded}</td>
                  <td className="px-5 py-3 text-neutral-600">
                    {PAYMENT_STATUS_LABELS[charge.status] ?? charge.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
