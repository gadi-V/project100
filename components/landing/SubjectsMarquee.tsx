import { BookOpen, Landmark, type LucideIcon } from "lucide-react";
import styles from "./SubjectsMarquee.module.css";

type MarqueeRow = {
  id: string;
  label: string;
  items: readonly string[];
  Icon: LucideIcon;
  durationSec: number;
  reverse?: boolean;
  tone: "course" | "institution";
};

const ROWS: readonly MarqueeRow[] = [
  {
    id: "school",
    label: "תיכון ובגרות",
    Icon: BookOpen,
    durationSec: 38,
    tone: "course",
    items: [
      "פסיכומטרי",
      'מתמטיקה 5 יח"ל',
      'מתמטיקה 4 יח"ל',
      'מתמטיקה 3 יח"ל',
      "פיזיקה",
      "כימיה",
      "ביולוגיה",
      "מדעי המחשב",
      "אנגלית",
      "אמירנט",
    ],
  },
  {
    id: "academic",
    label: "קורסים אקדמיים",
    Icon: BookOpen,
    durationSec: 46,
    reverse: true,
    tone: "course",
    items: [
      'חדו"א 1',
      "אינפי",
      "אלגברה לינארית",
      "מכונות חשמל",
      "מעגלים חשמליים",
      'מד"ר',
      "הסתברות וסטטיסטיקה",
      "מכניקה",
      "תרמודינמיקה",
      "אותות ומערכות",
      "מבני נתונים",
      "תכנות C",
      "חוזק חומרים",
    ],
  },
  {
    id: "institutions",
    label: "מוסדות לימוד",
    Icon: Landmark,
    durationSec: 84,
    tone: "institution",
    items: [
      "הטכניון",
      "אוניברסיטת תל אביב",
      "האוניברסיטה העברית",
      "אוניברסיטת בן גוריון",
      "אוניברסיטת בר אילן",
      "אוניברסיטת חיפה",
      "אוניברסיטת אריאל",
      "אוניברסיטת רייכמן",
      "האוניברסיטה הפתוחה",
      "המכללה האקדמית אפקה",
      "האקדמית סמי שמעון",
      "המכללה האקדמית בראודה",
      "עזריאלי מכללה להנדסה",
      "המרכז האקדמי לב",
      "מכון טכנולוגי חולון - HIT",
      "המכללה האקדמית ספיר",
    ],
  },
];

const TONE_CLASS: Record<MarqueeRow["tone"], string> = {
  course: "bg-white/80 text-[#1d1d1f] border-white",
  institution: "bg-[#0071e3]/[0.06] text-[#0b4f9c] border-[#0071e3]/15",
};

function Chips({ row }: { row: MarqueeRow }) {
  const { Icon } = row;
  return (
    <ul className="flex shrink-0 gap-2 pe-2">
      {row.items.map((item) => (
        <li
          key={item}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-black shadow-sm ${TONE_CLASS[row.tone]}`}
        >
          <Icon aria-hidden="true" size={12} strokeWidth={2.25} className="opacity-50" />
          {item}
        </li>
      ))}
    </ul>
  );
}

type SubjectsMarqueeProps = {
  className?: string;
};

export default function SubjectsMarquee({ className = "" }: SubjectsMarqueeProps) {
  return (
    <div
      dir="rtl"
      className={`${styles.root} space-y-2.5 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)] ${className}`}
    >
      {ROWS.map((row) => (
        <div key={row.id} role="group" aria-label={row.label} className="overflow-hidden">
          <div
            className={`${styles.track} ${row.reverse ? styles.reverse : ""} flex w-max`}
            style={{ animationDuration: `${row.durationSec}s` }}
          >
            <Chips row={row} />
            <div aria-hidden="true" className="flex shrink-0">
              <Chips row={row} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
