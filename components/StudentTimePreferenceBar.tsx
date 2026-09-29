"use client";

import { ACTIVITY_HOUR_SLOTS } from "../lib/matching";
import { frostCard, secondaryCta } from "../lib/ui";

const DAY_OPTIONS = [
  { value: 0, label: "א'" },
  { value: 1, label: "ב'" },
  { value: 2, label: "ג'" },
  { value: 3, label: "ד'" },
  { value: 4, label: "ה'" },
  { value: 5, label: "ו'" },
  { value: 6, label: "ש'" },
] as const;

const ALL_DAY_VALUES = DAY_OPTIONS.map((d) => d.value);

/** Label a 60-minute slot start as `HH:00-HH+1:00` within 08:00–22:00. */
export function formatHourSlotLabel(start: string): string {
  const hour = Number.parseInt(start.split(":")[0] ?? "0", 10);
  const endHour = hour + 1;
  return `${String(hour).padStart(2, "0")}:00-${String(endHour).padStart(2, "0")}:00`;
}

export type StudentTimeWindow = {
  id: string;
  start: string;
  end: string;
};

export type StudentTimePreference = {
  requestedDays: number[];
  /** Discrete slot starts; also sent as `requestedSlots` to `/api/match`. */
  requestedTimes: string[];
  timeWindows: StudentTimeWindow[];
};

interface StudentTimePreferenceBarProps {
  value: StudentTimePreference;
  busy?: boolean;
  onChange: (next: StudentTimePreference) => void;
  onClear: () => void;
}

function toggleInList<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function hasActiveTimePreference(value: StudentTimePreference): boolean {
  return (
    value.requestedDays.length > 0 ||
    value.requestedTimes.length > 0 ||
    value.timeWindows.length > 0
  );
}

export default function StudentTimePreferenceBar({
  value,
  busy = false,
  onChange,
  onClear,
}: StudentTimePreferenceBarProps) {
  const hasFilter = hasActiveTimePreference(value);
  const allDaysSelected = ALL_DAY_VALUES.every((d) => value.requestedDays.includes(d));
  const allSlotsSelected = ACTIVITY_HOUR_SLOTS.every((h) =>
    value.requestedTimes.includes(h)
  );

  const toggleDay = (day: number) => {
    onChange({
      ...value,
      requestedDays: toggleInList(value.requestedDays, day).sort((a, b) => a - b),
    });
  };

  const selectAllDays = () => {
    onChange({
      ...value,
      requestedDays: allDaysSelected ? [] : [...ALL_DAY_VALUES],
    });
  };

  const toggleHour = (hour: string) => {
    onChange({
      ...value,
      requestedTimes: toggleInList(value.requestedTimes, hour).sort(),
    });
  };

  const selectAllHours = () => {
    onChange({
      ...value,
      requestedTimes: allSlotsSelected ? [] : [...ACTIVITY_HOUR_SLOTS],
    });
  };

  return (
    <div className={`${frostCard} p-5 space-y-4 text-start`}>
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900">מתי נוח לך ללמוד?</h3>
          <p className="text-xs text-neutral-500 mt-1">
            סמנו ימים ושעות שנוחים לך, ונציג מורים שפנויים בהם.
          </p>
        </div>
        {hasFilter && (
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className={`${secondaryCta} self-start text-xs py-2 px-3`}
          >
            נקה הכל
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-[14px] font-medium text-neutral-500">ימים</label>
          <button
            type="button"
            disabled={busy}
            onClick={selectAllDays}
            className="text-[13px] font-medium px-2.5 py-1 rounded-full border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {allDaysSelected ? "בטל הכל" : "בחר הכל"}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 justify-start">
          {DAY_OPTIONS.map((day) => {
            const active = value.requestedDays.includes(day.value);
            return (
              <button
                key={day.value}
                type="button"
                disabled={busy}
                aria-pressed={active}
                onClick={() => toggleDay(day.value)}
                className={`text-[14px] font-medium px-3 py-1.5 rounded-full border transition-all disabled:opacity-50 ${
                  active
                    ? "bg-neutral-900 border-neutral-900 text-white"
                    : "bg-white border-neutral-200 text-neutral-600 hover:border-neutral-400"
                }`}
              >
                {day.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-[14px] font-medium text-neutral-500">שעות</label>
          <button
            type="button"
            disabled={busy}
            onClick={selectAllHours}
            className="text-[13px] font-medium px-2.5 py-1 rounded-full border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {allSlotsSelected ? "בטל הכל" : "בחר הכל"}
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-1.5">
          {ACTIVITY_HOUR_SLOTS.map((hour) => {
            const active = value.requestedTimes.includes(hour);
            return (
              <button
                key={hour}
                type="button"
                disabled={busy}
                aria-pressed={active}
                onClick={() => toggleHour(hour)}
                className={`text-[13px] sm:text-[14px] font-mono font-medium px-2 py-2 rounded-xl border transition-all disabled:opacity-50 ${
                  active
                    ? "bg-neutral-900 border-neutral-900 text-white"
                    : "bg-neutral-50 border-neutral-200 text-neutral-600 hover:border-neutral-400"
                }`}
              >
                {formatHourSlotLabel(hour)}
              </button>
            );
          })}
        </div>
      </div>

      {busy && (
        <p className="text-[14px] text-neutral-500 text-start">מחפשים מורים פנויים...</p>
      )}
    </div>
  );
}
