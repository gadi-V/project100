"use client";

import { useEffect, useRef } from "react";
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
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[14px] font-black shadow-sm ${TONE_CLASS[row.tone]}`}
        >
          <Icon aria-hidden="true" size={12} strokeWidth={2.25} className="opacity-50" />
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * Drives the row with requestAnimationFrame instead of a CSS animation:
 * iOS Safari hands CSS transform animations to Core Animation and drops them
 * inside backdrop-filter / mask-image ancestors (.liquid-glass), freezing the rows.
 */
function MarqueeTrack({ row }: { row: MarqueeRow }) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    const viewport = track?.parentElement;
    if (!track || !viewport) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const direction = row.reverse ? -1 : 1;
    let loopWidth = track.scrollWidth / 2;
    let offset = 0;
    let last = 0;
    let frame = 0;
    let hovered = false;

    const step = (now: number) => {
      frame = window.requestAnimationFrame(step);
      const dt = last ? Math.min(now - last, 100) : 0;
      last = now;
      if (hovered || loopWidth <= 0) return;
      const delta = (loopWidth / (row.durationSec * 1000)) * dt * direction;
      offset = (((offset + delta) % loopWidth) + loopWidth) % loopWidth;
      track.style.transform = `translate3d(${offset}px, 0, 0)`;
    };

    const start = () => {
      if (frame) return;
      last = 0;
      frame = window.requestAnimationFrame(step);
    };
    const stop = () => {
      if (!frame) return;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const visibility = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) start();
      else stop();
    });
    visibility.observe(viewport);

    const resize = new ResizeObserver(() => {
      loopWidth = track.scrollWidth / 2;
    });
    resize.observe(track);

    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === "mouse") hovered = true;
    };
    const onLeave = () => {
      hovered = false;
    };
    viewport.addEventListener("pointerenter", onEnter);
    viewport.addEventListener("pointerleave", onLeave);

    return () => {
      stop();
      visibility.disconnect();
      resize.disconnect();
      viewport.removeEventListener("pointerenter", onEnter);
      viewport.removeEventListener("pointerleave", onLeave);
    };
  }, [row.durationSec, row.reverse]);

  return (
    <div ref={trackRef} className="flex w-max">
      <Chips row={row} />
      <div aria-hidden="true" className="flex shrink-0">
        <Chips row={row} />
      </div>
    </div>
  );
}

type SubjectsMarqueeProps = {
  className?: string;
};

export default function SubjectsMarquee({ className = "" }: SubjectsMarqueeProps) {
  return (
    <div
      dir="rtl"
      className={`space-y-2.5 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_10%,black_90%,transparent)] ${className}`}
    >
      {ROWS.map((row) => (
        <div key={row.id} role="group" aria-label={row.label} className={`${styles.row} overflow-hidden`}>
          <MarqueeTrack row={row} />
        </div>
      ))}
    </div>
  );
}
