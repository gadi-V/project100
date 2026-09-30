"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

type AmbientSection = "hero" | "challenge" | "pricing" | "faq";

const SECTION_ORDER: readonly AmbientSection[] = [
  "hero",
  "challenge",
  "pricing",
  "faq",
] as const;

/** DOM ids → mood preset (aliases share a palette) */
const SECTION_ALIASES: Record<string, AmbientSection> = {
  hero: "hero",
  challenge: "challenge",
  method: "challenge",
  pricing: "pricing",
  about: "faq",
  faq: "faq",
  contact: "faq",
};

/** Document order — last section whose top has crossed the trigger line wins */
const OBSERVE_IDS = [
  "hero",
  "challenge",
  "method",
  "pricing",
  "about",
  "faq",
  "contact",
] as const;

type OrbClasses = {
  orb1: string;
  orb2: string;
  orb3: string;
  orb4: string;
};

/**
 * Per-section ambient moods — full Tailwind class strings so JIT can see them.
 * Orb 1 = primary wash, Orb 2 = secondary accent, Orb 3 = depth fill,
 * Orb 4 = third hue that keeps the mix lively between sections.
 */
const PALETTES: Record<AmbientSection, OrbClasses> = {
  hero: {
    orb1: "bg-gradient-to-br from-sky-300/40 via-sky-200/20 to-transparent",
    orb2: "bg-gradient-to-tr from-amber-200/35 via-orange-100/20 to-transparent",
    orb3: "bg-gradient-to-tl from-fuchsia-200/30 via-pink-100/15 to-transparent",
    orb4: "bg-gradient-to-bl from-cyan-200/30 via-sky-100/15 to-transparent",
  },
  challenge: {
    orb1: "bg-gradient-to-br from-indigo-400/35 via-indigo-300/20 to-transparent",
    orb2: "bg-gradient-to-tr from-emerald-300/30 via-emerald-200/15 to-transparent",
    orb3: "bg-gradient-to-tl from-cyan-300/25 via-sky-200/15 to-transparent",
    orb4: "bg-gradient-to-bl from-violet-300/25 via-purple-200/15 to-transparent",
  },
  pricing: {
    orb1: "bg-gradient-to-br from-violet-400/35 via-violet-300/20 to-transparent",
    orb2: "bg-gradient-to-tr from-amber-300/35 via-amber-200/20 to-transparent",
    orb3: "bg-gradient-to-tl from-rose-300/30 via-pink-200/15 to-transparent",
    orb4: "bg-gradient-to-bl from-sky-300/25 via-indigo-200/15 to-transparent",
  },
  faq: {
    orb1: "bg-gradient-to-br from-teal-300/35 via-teal-200/20 to-transparent",
    orb2: "bg-gradient-to-tr from-rose-300/30 via-rose-200/15 to-transparent",
    orb3: "bg-gradient-to-tl from-amber-200/30 via-yellow-100/15 to-transparent",
    orb4: "bg-gradient-to-bl from-indigo-300/25 via-sky-200/15 to-transparent",
  },
};

const ORB_TRANSITION = "transition-all duration-1000 ease-out";

/**
 * Scroll-linked drift (px at full page scroll). Orbs move in different
 * directions so their colors overlap differently along the page.
 */
const ORB_DRIFT = {
  orb1: "translate3d(calc(var(--ambient-p) * -180px), calc(var(--ambient-p) * 260px), 0)",
  orb2: "translate3d(calc(var(--ambient-p) * 220px), calc(var(--ambient-p) * -160px), 0)",
  orb3: "translate3d(calc(var(--ambient-p) * -140px), calc(var(--ambient-p) * -240px), 0)",
  orb4: "translate3d(calc(var(--ambient-p) * 200px), calc(var(--ambient-p) * 180px), 0)",
} as const;

function scrollProgress(): number {
  const max = Math.max(
    document.documentElement.scrollHeight - window.innerHeight,
    1
  );
  return Math.min(Math.max(window.scrollY / max, 0), 1);
}

function resolveActiveSection(): AmbientSection {
  const viewportH = window.innerHeight;
  const triggerY = viewportH * 0.25;
  let mood: AmbientSection = "hero";
  let matchedContaining = false;

  // Prefer the section that currently contains the trigger line
  for (const id of OBSERVE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top <= triggerY && rect.bottom >= triggerY) {
      mood = SECTION_ALIASES[id] ?? mood;
      matchedContaining = true;
    }
  }

  if (matchedContaining) {
    return mood;
  }

  // Gaps / short bottom sections: last section whose top has crossed the line
  for (const id of OBSERVE_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= triggerY) {
      mood = SECTION_ALIASES[id] ?? mood;
    }
  }

  // Near page end — pin to the last visible observed section
  const docH = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  );
  if (window.scrollY + viewportH >= docH - 48) {
    for (let i = OBSERVE_IDS.length - 1; i >= 0; i -= 1) {
      const id = OBSERVE_IDS[i];
      const el = document.getElementById(id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top < viewportH && rect.bottom > 0) {
        return SECTION_ALIASES[id] ?? mood;
      }
    }
  }

  return mood;
}

/**
 * Fixed ambient mesh lighting. Palette layers crossfade as landing sections
 * scroll past a viewport trigger line.
 */
export default function AmbientCanvas() {
  const [activeSection, setActiveSection] = useState<AmbientSection>("hero");
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const update = () => {
      frame = 0;
      const next = resolveActiveSection();
      setActiveSection((prev) => (prev === next ? prev : next));
      canvasRef.current?.style.setProperty(
        "--ambient-p",
        reduceMotion.matches ? "0" : scrollProgress().toFixed(4)
      );
    };

    const onScrollOrResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);

    // Catch late layout / hash navigation
    const observer = new IntersectionObserver(onScrollOrResize, {
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
    for (const id of OBSERVE_IDS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScrollOrResize);
      window.removeEventListener("resize", onScrollOrResize);
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 overflow-hidden z-0"
      style={{ "--ambient-p": 0 } as CSSProperties}
      aria-hidden="true"
      data-active-section={activeSection}
    >
      {SECTION_ORDER.map((mood) => {
        const palette = PALETTES[mood];
        const isActive = activeSection === mood;

        return (
          <div
            key={mood}
            className={`absolute inset-0 ${ORB_TRANSITION} ${
              isActive ? "opacity-100" : "opacity-0"
            }`}
            data-mood={mood}
          >
            {/* Orb 1 — Top-right */}
            <div
              className={`absolute w-[600px] h-[600px] rounded-full blur-[90px] -top-20 -right-20 ${ORB_TRANSITION} ${palette.orb1}`}
              style={{ transform: ORB_DRIFT.orb1 }}
            />
            {/* Orb 2 — Mid-left */}
            <div
              className={`absolute w-[700px] h-[700px] rounded-full blur-[110px] top-[30%] -left-32 ${ORB_TRANSITION} ${palette.orb2}`}
              style={{ transform: ORB_DRIFT.orb2 }}
            />
            {/* Orb 3 — Bottom-right */}
            <div
              className={`absolute w-[650px] h-[650px] rounded-full blur-[100px] bottom-10 right-10 ${ORB_TRANSITION} ${palette.orb3}`}
              style={{ transform: ORB_DRIFT.orb3 }}
            />
            {/* Orb 4 — Top-left */}
            <div
              className={`absolute w-[520px] h-[520px] rounded-full blur-[100px] -top-24 left-[15%] ${ORB_TRANSITION} ${palette.orb4}`}
              style={{ transform: ORB_DRIFT.orb4 }}
            />
          </div>
        );
      })}
    </div>
  );
}
