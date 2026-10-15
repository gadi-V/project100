"use client";

import { useRef } from "react";
import { motion, useInView, useReducedMotion, type Transition } from "framer-motion";
import { Instrument_Serif } from "next/font/google";

const numeralFont = Instrument_Serif({ subsets: ["latin"], weight: "400", display: "swap" });

type Stat = {
  id: string;
  value: number;
  suffix?: string;
  label: string;
};

const STATS: readonly Stat[] = [
  { id: "students", value: 3412, label: "סטודנטים ותלמידים מרוצים" },
  { id: "gifted", value: 97, suffix: "%", label: "הצלחה במבחני מחוננים ועתודה" },
  { id: "bagrut", value: 93, suffix: "%", label: "מתלמידי הבגרות במתמטיקה מעל 90" },
  { id: "psychometric", value: 95, suffix: "%", label: "מתלמידי הפסיכומטרי עברו את ה-700" },
  { id: "engineering", value: 87, suffix: "%", label: "מהסטודנטים להנדסה ומדעי המחשב בציון מעל 85" },
  { id: "teachers", value: 10, suffix: "%", label: "מהמועמדים מתקבלים לצוות" },
];

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;
const ROLL_DURATION_S = 2.2;
const COLUMN_STAGGER_S = 0.07;
const STAT_STAGGER_S = 0.09;
/** Two stacked 0–9 runs so every column spins at least one full turn before landing. */
const REEL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const numberFormat = new Intl.NumberFormat("he-IL");

type DigitReelProps = {
  digit: number;
  play: boolean;
  instant: boolean;
  delay: number;
};

/**
 * `clip-path` instead of `overflow-hidden`: an inline-block with overflow set loses its text baseline,
 * which would knock the reels out of line with the static "%" and "טופ".
 */
function DigitReel({ digit, play, instant, delay }: DigitReelProps) {
  const landing = `-${((REEL.length / 2 + digit) * 100) / REEL.length}%`;
  const transition: Transition = instant
    ? { duration: 0 }
    : {
        y: { duration: ROLL_DURATION_S, ease: EASE_OUT_EXPO, delay },
        filter: { duration: ROLL_DURATION_S * 0.6, times: [0, 0.2, 1], ease: "easeOut", delay },
      };

  return (
    <span className="relative inline-block [clip-path:inset(0)]">
      <span className="invisible">0</span>
      <motion.span
        className="absolute inset-x-0 top-0 flex flex-col will-change-transform"
        initial={instant ? false : { y: "0%", filter: "blur(0px)" }}
        animate={
          play
            ? { y: landing, filter: instant ? "blur(0px)" : ["blur(0px)", "blur(1.5px)", "blur(0px)"] }
            : { y: "0%", filter: "blur(0px)" }
        }
        transition={transition}
      >
        {REEL.map((n, i) => (
          <span key={i} className="text-center">
            {n}
          </span>
        ))}
      </motion.span>
    </span>
  );
}

type NumberTickerProps = {
  stat: Stat;
  play: boolean;
  instant: boolean;
  baseDelay: number;
};

function NumberTicker({ stat, play, instant, baseDelay }: NumberTickerProps) {
  const formatted = numberFormat.format(stat.value);
  let digitIndex = 0;

  return (
    <p
      aria-label={`${formatted}${stat.suffix ?? ""}`}
      className="flex items-baseline whitespace-nowrap text-zinc-950"
    >
      <bdi
        aria-hidden="true"
        dir="ltr"
        className={`${numeralFont.className} inline-flex items-baseline text-[1.75rem] leading-[1.1] tabular-nums [-webkit-text-stroke:0.6px_currentColor] sm:text-[2rem]`}
      >
        {[...formatted].map((char, i) => {
          if (!/\d/.test(char)) {
            return (
              <span key={i} className="text-zinc-600">
                {char}
              </span>
            );
          }
          const delay = baseDelay + digitIndex++ * COLUMN_STAGGER_S;
          return <DigitReel key={i} digit={Number(char)} play={play} instant={instant} delay={delay} />;
        })}
        {stat.suffix && <span className="ms-0.5 text-[0.7em] font-medium text-zinc-700">{stat.suffix}</span>}
      </bdi>
    </p>
  );
}

/**
 * Full-height hairlines for a 2 → 3 → 6 column flow: a start border between neighbours in a row,
 * a top border on every wrapped row. Each cell decides from its index which ones apply at each breakpoint.
 */
function cellBorders(index: number): string {
  return [
    index % 2 !== 0 ? "border-s" : "border-s-0",
    index >= 2 ? "border-t" : "border-t-0",
    index % 3 !== 0 ? "sm:border-s" : "sm:border-s-0",
    index >= 3 ? "sm:border-t" : "sm:border-t-0",
    index !== 0 ? "xl:border-s" : "xl:border-s-0",
    "xl:border-t-0",
  ].join(" ");
}

export default function StatsBar() {
  const barRef = useRef<HTMLUListElement>(null);
  const inView = useInView(barRef, { once: true, amount: 0.4 });
  const instant = useReducedMotion() === true;
  const play = inView || instant;

  return (
    <section aria-labelledby="stats-heading" dir="rtl" className="mx-auto max-w-7xl px-6 py-24 sm:py-32 lg:px-10">
      <div className="mx-auto max-w-2xl space-y-4 text-center">
        <h2 id="stats-heading" className="text-4xl font-semibold tracking-tight text-zinc-900 sm:text-5xl">
          תוצאות שאפשר למדוד
        </h2>
        <p className="mx-auto max-w-xl text-base leading-relaxed text-zinc-500 sm:text-lg">
          מאחורי כל מספר יש תלמידים וסטודנטים שעבדו איתנו שיעור אחרי שיעור. ככה זה נראה בסוף הדרך.
        </p>
      </div>

      <div className="relative mx-auto mt-16 max-w-5xl overflow-hidden rounded-[1.75rem] border border-white/50 shadow-[0_8px_30px_rgba(0,0,0,0.03),inset_0_1px_0_rgba(255,255,255,0.7),inset_0_-1px_0_rgba(255,255,255,0.15)]">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-8 top-0 z-10 h-px bg-linear-to-r from-transparent via-white to-transparent"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] bg-linear-to-b from-white/[0.12] via-transparent to-transparent"
        />
        <ul ref={barRef} className="grid grid-cols-2 sm:grid-cols-3 xl:flex">
          {STATS.map((stat, index) => {
            const baseDelay = index * STAT_STAGGER_S;
            return (
              <li
                key={stat.id}
                className={`group flex flex-1 flex-col items-center justify-start border-white/30 bg-zinc-600/[0.08] px-6 py-6 text-center backdrop-blur-[6px] backdrop-saturate-[.6] transition-colors duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-zinc-600/[0.12] sm:px-8 xl:px-3 xl:py-6 ${cellBorders(index)}`}
              >
                <div className="transition-transform duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
                  <NumberTicker stat={stat} play={play} instant={instant} baseDelay={baseDelay} />
                </div>
                <motion.p
                  initial={instant ? false : { opacity: 0, y: 6 }}
                  animate={play ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
                  transition={instant ? { duration: 0 } : { duration: 1, ease: EASE_OUT_EXPO, delay: baseDelay + 0.5 }}
                  className="mt-1.5 max-w-[12rem] text-balance text-sm leading-snug font-semibold xl:text-[13px] text-zinc-700 transition-colors duration-700 group-hover:text-zinc-800"
                >
                  {stat.label}
                </motion.p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
