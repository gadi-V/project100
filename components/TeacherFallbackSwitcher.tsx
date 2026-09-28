"use client";

import { useMemo, useState } from "react";
import {
  badgeSuccess,
  badgeWarning,
  fieldClass,
  frostCard,
  secondaryCta,
} from "../lib/ui";

export interface FallbackTeacher {
  teacherId: string;
  teacherName: string;
  matchScore: number;
  openSlotsCount: number;
  subjects: string[];
  reasons: string[];
  isSoftRecommendation?: boolean;
}

interface TeacherFallbackSwitcherProps {
  teachers: FallbackTeacher[];
  selectedTeacherId: string | null;
  /** When true, expand the panel automatically (e.g. 0 slots in displayed week). */
  forceOpen?: boolean;
  busy?: boolean;
  onSelectTeacher: (teacher: FallbackTeacher) => void;
}

export default function TeacherFallbackSwitcher({
  teachers,
  selectedTeacherId,
  forceOpen = false,
  busy = false,
  onSelectTeacher,
}: TeacherFallbackSwitcherProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [query, setQuery] = useState("");

  const isOpen = forceOpen || manualOpen;

  const alternatives = useMemo(() => {
    const q = query.trim().toLowerCase();
    return teachers
      .filter((t) => t.teacherId !== selectedTeacherId)
      .filter((t) => {
        if (!q) return true;
        const hay = `${t.teacherName} ${t.subjects.join(" ")}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [teachers, selectedTeacherId, query]);

  return (
    <div className={`${frostCard} p-4 space-y-3 text-start border-amber-200/80 bg-amber-50/40`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">
            {forceOpen
              ? "אין שעות פנויות למורה בשבוע זה"
              : "רוצה לבדוק מורה אחר?"}
          </h3>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            מורים נוספים שמתאימים למקצוע שלך. בחירה תציג את השעות שלהם בלוח.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => setManualOpen((v) => !v)}
          className={`${secondaryCta} self-start text-[11px] py-2 px-3`}
        >
          {isOpen && !forceOpen ? "סגור חיפוש" : "החלף מורה"}
        </button>
      </div>

      {isOpen && (
        <div className="space-y-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="חיפוש לפי שם או מקצוע..."
            className={fieldClass}
            dir="rtl"
          />

          {alternatives.length === 0 ? (
            <div className="bg-neutral-50 border border-neutral-200 rounded-2xl p-6 text-center space-y-2">
              <p className="text-sm font-medium text-neutral-900">לא נמצאו מורים חלופיים</p>
              <p className="text-xs text-neutral-500">
                נסו לשנות את החיפוש או את העדפות הזמן למעלה.
              </p>
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {alternatives.map((teacher) => (
                <button
                  key={teacher.teacherId}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    onSelectTeacher(teacher);
                    setManualOpen(false);
                    setQuery("");
                  }}
                  className="min-w-[180px] shrink-0 text-start bg-white border border-neutral-200 hover:border-neutral-400 hover:bg-neutral-50 active:scale-[0.98] p-3 rounded-xl transition-all disabled:opacity-50"
                >
                  <div className="text-xs font-semibold text-neutral-900 truncate">
                    {teacher.teacherName}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {teacher.openSlotsCount > 0 ? (
                      <span className={badgeSuccess}>
                        {teacher.openSlotsCount} שעות פנויות
                      </span>
                    ) : (
                      <span className={badgeWarning}>אין שעות פנויות כרגע</span>
                    )}
                  </div>
                  {teacher.subjects.length > 0 && (
                    <div className="text-[10px] text-neutral-500 mt-1.5 truncate">
                      {teacher.subjects.slice(0, 2).join(" · ")}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
