"use client";

import TeacherPayoutsBoard from "../../../components/admin/TeacherPayoutsBoard";
import { pageCanvas } from "../../../lib/ui";

/**
 * Teacher payroll for ADMIN / MANAGER: open balance per teacher from the PAYOUT ledger, bank details,
 * bank-transfer CSV export and "סמן תשלום כבוצע" (`POST /api/admin/payouts`, a `payout-paid-` ledger offset).
 * The API enforces the role; the per-payout queue stays on the `/admin` payouts tab.
 */
export default function AdminPayoutsPage() {
  return (
    <div className={`${pageCanvas} p-4 sm:p-8`} dir="rtl">
      <TeacherPayoutsBoard />
    </div>
  );
}
