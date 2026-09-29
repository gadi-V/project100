import {
  ENROLLMENT_TYPE_LABELS,
  formatIsraelDateTime,
  type CourseRow,
} from "../../../lib/student-portal-shared";
import { badgeNeutral, badgeSuccess, emptyState, frostPanel } from "../../../lib/ui";

type CoursesTabProps = {
  courses: CourseRow[];
};

function upcomingText(course: CourseRow): string {
  if (course.kind === "MAPPING") return "שיחה שהתקיימה";
  if (!course.nextMeetingAt) return "אין מפגשים קרובים";
  const more = course.upcomingCount > 1 ? ` · עוד ${course.upcomingCount - 1} אחריו` : "";
  return `${formatIsraelDateTime(course.nextMeetingAt)}${more}`;
}

export default function CoursesTab({ courses }: CoursesTabProps) {
  if (courses.length === 0) {
    return (
      <div className={emptyState}>
        <p className="text-sm text-neutral-600">התלמיד/ה עדיין לא רשום/ה לקורס או למיפוי.</p>
      </div>
    );
  }

  return (
    <section className={`${frostPanel} overflow-x-auto`} aria-label="הרשמות">
      <table className="w-full text-sm text-start">
        <thead className="text-xs text-neutral-500 border-b border-neutral-100">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">קורס / מיפוי</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">שעות פעילות</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">סוג רישום</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">מורה משובץ</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">מפגשים קרובים</th>
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
              <td className="px-5 py-4 text-neutral-700">
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
              <td className="px-5 py-4 text-neutral-700">{course.teacherName ?? "טרם שובץ"}</td>
              <td className="px-5 py-4 text-neutral-700">{upcomingText(course)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
