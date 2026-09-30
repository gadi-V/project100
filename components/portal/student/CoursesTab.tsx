"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-hot-toast";
import {
  ENROLLMENT_TYPE_LABELS,
  formatIsraelDateTime,
  formatIsraelDay,
  type CourseRow,
} from "../../../lib/student-portal-shared";
import {
  formatWeeklySchedule,
  SUBSCRIPTION_TYPE_LABELS,
  type DirectPackageResult,
  type EnrollmentPlans,
  type PedagogicDecisionResult,
} from "../../../lib/pedagogic-decision";
import { badgeNeutral, badgeSuccess, emptyState, frostPanel, primaryCta, secondaryCta } from "../../../lib/ui";
import PedagogicDecisionModal from "./PedagogicDecisionModal";
import DirectPackageModal from "./DirectPackageModal";

type CoursesTabProps = {
  studentId: string;
  courses: CourseRow[];
  plans: EnrollmentPlans;
  /** MANAGER (pedagogic manager) / ADMIN / REPRESENTATIVE may decide a subscription or assign a package. */
  canDecide: boolean;
};

type OpenModal = "decision" | "package" | null;

function upcomingText(course: CourseRow): string {
  if (course.kind === "MAPPING") return "שיחה שהתקיימה";
  if (!course.nextMeetingAt) return "אין מפגשים קרובים";
  const more = course.upcomingCount > 1 ? ` · עוד ${course.upcomingCount - 1} אחריו` : "";
  return `${formatIsraelDateTime(course.nextMeetingAt)}${more}`;
}

function dateKeyLabel(dateKey: string): string {
  return dateKey.split("-").reverse().join(".");
}

const headCell = "px-5 py-3 text-start font-medium";
const bodyCell = "px-5 py-4 text-neutral-700";

function SubscriptionsTable({ plans }: { plans: EnrollmentPlans }) {
  return (
    <section className={`${frostPanel} overflow-x-auto`} aria-label="מנויים שבועיים קבועים">
      <h3 className="px-5 pt-4 text-sm font-semibold text-neutral-900">מנויים שבועיים קבועים</h3>
      {plans.subscriptions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-neutral-500">עדיין לא נקבע מנוי קבוע.</p>
      ) : (
        <table className="w-full text-sm text-start">
          <thead className="text-xs text-neutral-500 border-b border-neutral-100">
            <tr>
              <th scope="col" className={headCell}>מקצוע</th>
              <th scope="col" className={headCell}>מסלול</th>
              <th scope="col" className={headCell}>מורה קבוע</th>
              <th scope="col" className={headCell}>מועדים קבועים</th>
              <th scope="col" className={headCell}>תחילת לימודים</th>
              <th scope="col" className={headCell}>תוספת ש.פ</th>
            </tr>
          </thead>
          <tbody>
            {plans.subscriptions.map((row) => (
              <tr key={row.id} className="border-b border-neutral-100 last:border-b-0 align-top">
                <td className="px-5 py-4 font-medium text-neutral-900">{row.subject}</td>
                <td className="px-5 py-4">
                  <span className={badgeSuccess}>{SUBSCRIPTION_TYPE_LABELS[row.subscriptionType]}</span>
                </td>
                <td className={bodyCell}>{row.teacherName}</td>
                <td className={bodyCell}>{formatWeeklySchedule(row.slots)}</td>
                <td className={bodyCell}>{dateKeyLabel(row.startDate)}</td>
                <td className={bodyCell}>{row.extraPrivateLessons === 0 ? "אין" : row.extraPrivateLessons}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function PackagesTable({ plans }: { plans: EnrollmentPlans }) {
  return (
    <section className={`${frostPanel} overflow-x-auto`} aria-label="חבילות שעות">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4">
        <h3 className="text-sm font-semibold text-neutral-900">חבילות שעות</h3>
        {plans.lessonCredits !== null && (
          <span className={plans.lessonCredits > 0 ? badgeSuccess : badgeNeutral}>
            יתרה: {plans.lessonCredits} שיעורים
          </span>
        )}
      </div>
      {plans.packages.length === 0 ? (
        <p className="px-5 py-4 text-sm text-neutral-500">לא שויכה חבילה ישירה.</p>
      ) : (
        <table className="w-full text-sm text-start">
          <thead className="text-xs text-neutral-500 border-b border-neutral-100">
            <tr>
              <th scope="col" className={headCell}>חבילה</th>
              <th scope="col" className={headCell}>מקצוע</th>
              <th scope="col" className={headCell}>שיעורים בחבילה</th>
              <th scope="col" className={headCell}>מורה מועדף</th>
              <th scope="col" className={headCell}>שויכה בתאריך</th>
            </tr>
          </thead>
          <tbody>
            {plans.packages.map((row) => (
              <tr key={row.id} className="border-b border-neutral-100 last:border-b-0 align-top">
                <td className="px-5 py-4 font-medium text-neutral-900">{row.packageName}</td>
                <td className={bodyCell}>{row.subject}</td>
                <td className={bodyCell}>{row.credits}</td>
                <td className={bodyCell}>{row.preferredTeacherName ?? "ללא העדפה"}</td>
                <td className={bodyCell}>{formatIsraelDay(row.assignedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default function CoursesTab({ studentId, courses, plans, canDecide }: CoursesTabProps) {
  const router = useRouter();
  const [openModal, setOpenModal] = useState<OpenModal>(null);
  const closeModal = useCallback(() => setOpenModal(null), []);

  const handleDecision = (result: PedagogicDecisionResult, whatsappDispatched: boolean) => {
    setOpenModal(null);
    const scheduled = `ההכרעה נשמרה ו-${result.lessonsCreated} שיעורים שובצו`;
    if (whatsappDispatched) toast.success(`${scheduled}. תוכנית הלמידה נשלחה לקבוצת הוואטסאפ.`);
    else toast.success(`${scheduled}. ההודעה לקבוצת הוואטסאפ לא נשלחה, כדאי לעדכן ידנית.`);
    router.refresh();
  };

  const handlePackage = (result: DirectPackageResult) => {
    setOpenModal(null);
    toast.success(`${result.packageName} שויכה. יתרה: ${result.lessonCredits} שיעורים.`);
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {canDecide && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" className={`${secondaryCta} py-2`} onClick={() => setOpenModal("package")}>
            שיוך חבילת שעות ישירה
          </button>
          <button type="button" className={`${primaryCta} py-2`} onClick={() => setOpenModal("decision")}>
            הכרעה פדגוגית ומנוי שנתי
          </button>
        </div>
      )}

      <SubscriptionsTable plans={plans} />
      <PackagesTable plans={plans} />

      {courses.length === 0 ? (
        <div className={emptyState}>
          <p className="text-sm text-neutral-600">התלמיד/ה עדיין לא רשום/ה לקורס או למיפוי.</p>
        </div>
      ) : (
        <section className={`${frostPanel} overflow-x-auto`} aria-label="הרשמות">
          <table className="w-full text-sm text-start">
            <thead className="text-xs text-neutral-500 border-b border-neutral-100">
              <tr>
                <th scope="col" className={headCell}>קורס / מיפוי</th>
                <th scope="col" className={headCell}>שעות פעילות</th>
                <th scope="col" className={headCell}>סוג רישום</th>
                <th scope="col" className={headCell}>מורה משובץ</th>
                <th scope="col" className={headCell}>מפגשים קרובים</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((course) => (
                <tr key={course.key} className="border-b border-neutral-100 last:border-b-0 align-top">
                  <td className="px-5 py-4">
                    <span className="block font-medium text-neutral-900">{course.title}</span>
                    {course.kind === "COURSE" && course.completedCount > 0 && (
                      <span className="block text-xs text-neutral-500">{course.completedCount} מפגשים הסתיימו</span>
                    )}
                  </td>
                  <td className={bodyCell}>
                    {course.schedule.length > 0 ? (
                      <ul className="space-y-0.5">
                        {course.schedule.map((slot) => (
                          <li key={slot}>{slot}</li>
                        ))}
                      </ul>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-5 py-4">
                    <span className={course.enrollmentType === "SUBSCRIPTION" ? badgeSuccess : badgeNeutral}>
                      {ENROLLMENT_TYPE_LABELS[course.enrollmentType]}
                    </span>
                  </td>
                  <td className={bodyCell}>{course.teacherName ?? "טרם שובץ"}</td>
                  <td className={bodyCell}>{upcomingText(course)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {openModal === "decision" && (
        <PedagogicDecisionModal studentId={studentId} onClose={closeModal} onSaved={handleDecision} />
      )}
      {openModal === "package" && (
        <DirectPackageModal studentId={studentId} onClose={closeModal} onAssigned={handlePackage} />
      )}
    </div>
  );
}
