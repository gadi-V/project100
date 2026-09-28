import type { ComponentType } from "react";

type BenefitIconProps = {
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

type Benefit = {
  id: string;
  Icon: ComponentType<BenefitIconProps>;
  title: string;
  description: string;
};

function PersonBadge({ cx, cy, fill }: { cx: number; cy: number; fill: string }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={13} fill={fill} stroke="#fff" strokeWidth={1.5} />
      <g fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round">
        <circle cx={cx} cy={cy} r={8} />
        <circle cx={cx} cy={cy - 2} r={2.8} />
        <path d={`M${cx - 5} ${cy + 6} a5.2 4.6 0 0 1 10 0`} />
      </g>
    </g>
  );
}

function OneOnOneIcon({ className, "aria-hidden": ariaHidden }: BenefitIconProps) {
  return (
    <svg width={24} height={24} viewBox="0 0 48 48" className={className} aria-hidden={ariaHidden}>
      <defs>
        <linearGradient id="benefit-1on1-back" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="benefit-1on1-front" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <PersonBadge cx={30} cy={17} fill="url(#benefit-1on1-back)" />
      <PersonBadge cx={18} cy={31} fill="url(#benefit-1on1-front)" />
    </svg>
  );
}

function PathToGoalIcon({ className, "aria-hidden": ariaHidden }: BenefitIconProps) {
  return (
    <svg width={24} height={24} viewBox="0 0 48 48" className={className} aria-hidden={ariaHidden}>
      <defs>
        <linearGradient id="benefit-path" x1="8" y1="40" x2="44" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <g stroke="url(#benefit-path)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M10 38 L31 31 L17 23 L31.5 18.5" />
        <circle cx={34} cy={18} r={3} />
        <path d="M34 15 V5" />
      </g>
      <g fill="url(#benefit-path)">
        <circle cx={10} cy={38} r={4} />
        <circle cx={31} cy={31} r={2.8} />
        <circle cx={17} cy={23} r={2.8} />
        <path d="M34 4.5 h10 l-2.8 3.75 l2.8 3.75 h-10 z" />
      </g>
    </svg>
  );
}

function RisingBarsIcon({ className, "aria-hidden": ariaHidden }: BenefitIconProps) {
  const bars = [11.5, 17.5, 23, 30];
  return (
    <svg width={24} height={24} viewBox="0 0 48 48" className={className} aria-hidden={ariaHidden}>
      <defs>
        <linearGradient id="benefit-bars" x1="6" y1="10" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#5b21b6" />
        </linearGradient>
      </defs>
      <g fill="url(#benefit-bars)">
        {bars.map((height, i) => (
          <rect key={height} x={5.25 + i * 10.5} y={41 - height} width={6} height={height} rx={2} />
        ))}
      </g>
    </svg>
  );
}

function FlexibleChoiceIcon({ className, "aria-hidden": ariaHidden }: BenefitIconProps) {
  return (
    <svg width={24} height={24} viewBox="0 0 48 48" className={className} aria-hidden={ariaHidden}>
      <defs>
        <linearGradient id="benefit-flex" x1="24" y1="3" x2="24" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <g stroke="url(#benefit-flex)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M24 13 V3.5 M21 6.5 L24 3.5 L27 6.5" />
        <path d="M22.3 12.3 L16 6 M16 10.2 V6 H20.2" />
        <path d="M25.7 12.3 L32 6 M32 10.2 V6 H27.8" />
        <circle cx={24} cy={19.5} r={3.2} />
        <path d="M13.5 21 C16.5 26 20 27 24 27 C28 27 31.5 26 34.5 21" />
        <path d="M24 27 V32.5" />
        <path d="M24 32.5 C19.5 32.5 16.5 34.8 15 37.5 H33 C31.5 34.8 28.5 32.5 24 32.5 Z" />
        <path d="M12 37.5 H4 M7.5 34 L4 37.5 L7.5 41" />
        <path d="M36 37.5 H44 M40.5 34 L44 37.5 L40.5 41" />
      </g>
    </svg>
  );
}

function ChecklistIcon({ className, "aria-hidden": ariaHidden }: BenefitIconProps) {
  const rows = [18.5, 25, 31.5, 38];
  return (
    <svg width={24} height={24} viewBox="0 0 48 48" className={className} aria-hidden={ariaHidden}>
      <defs>
        <linearGradient id="benefit-checklist" x1="24" y1="4" x2="24" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <g stroke="url(#benefit-checklist)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <rect x={10} y={8} width={28} height={36} rx={3} />
        <path d="M16 4.5 V11.5 M21.3 4.5 V11.5 M26.7 4.5 V11.5 M32 4.5 V11.5" />
        {rows.map((y) => (
          <path key={y} d={`M15 ${y} H24.5 M28 ${y} l2.2 2.2 l4 -4.4`} />
        ))}
      </g>
    </svg>
  );
}

const BENEFITS: readonly Benefit[] = [
  {
    id: "one-on-one",
    Icon: OneOnOneIcon,
    title: "שיעורים פרטיים 1-על-1",
    description: "ליווי אישי ממוקד בקצב שלך",
  },
  {
    id: "foundations",
    Icon: PathToGoalIcon,
    title: "סגירת פערים מהיסוד",
    description: "לא נדרש ידע קודם",
  },
  {
    id: "eye-level",
    Icon: RisingBarsIcon,
    title: "בגובה העיניים",
    description: "פירוק מושגים מורכבים להבנה פשוטה",
  },
  {
    id: "flexible-hours",
    Icon: FlexibleChoiceIcon,
    title: "גמישות מלאה בשעות",
    description: "תיאום ישיר מהבית ובזמן שמתאים לך",
  },
  {
    id: "exam-prep",
    Icon: ChecklistIcon,
    title: "הכנה ממוקדת לבחינה",
    description: "תרגול רב של מבחנים והקניית טכניקות",
  },
];

type BenefitsBarProps = {
  className?: string;
};

export default function BenefitsBar({ className = "" }: BenefitsBarProps) {
  return (
    <section
      aria-label="היתרונות שלנו"
      dir="rtl"
      className={`border-y border-slate-100 bg-slate-50/70 ${className}`}
    >
      <ul
        className="mx-auto flex max-w-6xl snap-x snap-mandatory gap-3 overflow-x-auto scroll-ps-4 px-4 py-6 [scrollbar-width:none] md:grid md:grid-cols-5 md:gap-4 md:overflow-visible md:px-6 md:py-8 [&::-webkit-scrollbar]:hidden"
      >
        {BENEFITS.map(({ id, Icon, title, description }) => (
          <li
            key={id}
            className="flex w-[70%] shrink-0 snap-start items-stretch gap-2 rounded-2xl border border-slate-100 bg-white/80 ps-4 pe-3 py-4 sm:w-[45%] md:w-auto md:border-0 md:bg-transparent md:p-0"
          >
            <span className="flex aspect-square min-h-10 shrink-0 items-center justify-center rounded-xl bg-white text-slate-700 ring-1 ring-slate-200/80">
              <Icon aria-hidden="true" className="h-[80%] w-[80%]" />
            </span>
            <div className="min-w-0 space-y-1 text-start">
              <h3 className="text-sm font-semibold leading-snug text-slate-900 lg:whitespace-nowrap lg:tracking-tight">{title}</h3>
              <p className="text-xs leading-relaxed text-slate-500">{description}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
