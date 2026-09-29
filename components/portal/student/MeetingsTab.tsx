"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import {
  formatIsraelDateTime,
  LESSON_STATUS_LABELS,
  type AttendanceStatus,
  type MeetingRow,
} from "../../../lib/student-portal-shared";
import { emptyState, frostPanel } from "../../../lib/ui";

type MeetingsTabProps = {
  studentId: string;
  meetings: MeetingRow[];
};

type AttendanceResponse = {
  success: boolean;
  data?: { lessonId: string; attendanceStatus: AttendanceStatus };
  error?: string;
};

const israelTime = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function attendanceButtonClass(kind: AttendanceStatus, selected: boolean): string {
  const base = "rounded-full px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-40";
  if (kind === "PRESENT") {
    return selected
      ? `${base} bg-emerald-600 text-white`
      : `${base} border border-emerald-200 text-emerald-700 hover:bg-emerald-50`;
  }
  return selected
    ? `${base} bg-neutral-500 text-white`
    : `${base} border border-neutral-200 text-neutral-600 hover:bg-neutral-100`;
}

export default function MeetingsTab({ studentId, meetings }: MeetingsTabProps) {
  const [attendance, setAttendance] = useState<Record<string, AttendanceStatus | null>>(() =>
    Object.fromEntries(meetings.map((m) => [m.id, m.attendanceStatus]))
  );
  const [savingId, setSavingId] = useState<string | null>(null);

  const mark = async (lessonId: string, status: AttendanceStatus) => {
    setSavingId(lessonId);
    try {
      const res = await fetch(`/api/portal/students/${encodeURIComponent(studentId)}/attendance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lessonId, status }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as AttendanceResponse;
      if (!res.ok || !json.success || !json.data) throw new Error(json.error ?? "סימון הנוכחות נכשל");
      const saved = json.data;
      setAttendance((prev) => ({ ...prev, [saved.lessonId]: saved.attendanceStatus }));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "סימון הנוכחות נכשל");
    } finally {
      setSavingId(null);
    }
  };

  if (meetings.length === 0) {
    return (
      <div className={emptyState}>
        <p className="text-sm text-neutral-600">עדיין לא נקבעו מפגשים.</p>
      </div>
    );
  }

  return (
    <section className={`${frostPanel} overflow-x-auto`} aria-label="לוח מפגשים">
      <table className="w-full text-sm">
        <thead className="text-xs text-neutral-500 border-b border-neutral-100">
          <tr>
            <th scope="col" className="px-5 py-3 text-start font-medium">תאריך ושעה</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">שיעור</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">מורה</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">מצב</th>
            <th scope="col" className="px-5 py-3 text-start font-medium">נוכחות</th>
          </tr>
        </thead>
        <tbody>
          {meetings.map((meeting) => {
            const current = attendance[meeting.id] ?? null;
            const busy = savingId === meeting.id;
            return (
              <tr key={meeting.id} className="border-b border-neutral-100 last:border-b-0">
                <td className="px-5 py-4 whitespace-nowrap text-neutral-800">
                  {formatIsraelDateTime(meeting.scheduledAt)}–{israelTime.format(new Date(meeting.endsAt))}
                </td>
                <td className="px-5 py-4 font-medium text-neutral-900">{meeting.title}</td>
                <td className="px-5 py-4 text-neutral-700">{meeting.teacherName ?? "—"}</td>
                <td className="px-5 py-4 text-neutral-600">{LESSON_STATUS_LABELS[meeting.status] ?? meeting.status}</td>
                <td className="px-5 py-4">
                  {meeting.canMarkAttendance ? (
                    <div className="flex gap-2" role="group" aria-label="סימון נוכחות">
                      <button
                        type="button"
                        aria-pressed={current === "PRESENT"}
                        className={attendanceButtonClass("PRESENT", current === "PRESENT")}
                        disabled={busy}
                        onClick={() => mark(meeting.id, "PRESENT")}
                      >
                        נוכח
                      </button>
                      <button
                        type="button"
                        aria-pressed={current === "ABSENT"}
                        className={attendanceButtonClass("ABSENT", current === "ABSENT")}
                        disabled={busy}
                        onClick={() => mark(meeting.id, "ABSENT")}
                      >
                        לא נוכח
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-neutral-400">
                      {current === "PRESENT" ? "נוכח" : current === "ABSENT" ? "לא נוכח" : "—"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
