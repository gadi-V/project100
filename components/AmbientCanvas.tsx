"use client";

import { useEffect, useState } from "react";

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
};

/**
 * Per-section ambient moods — full Tailwind class strings so JIT can see them.
 * Orb 1 = primary wash, Orb 2 = secondary accent, Orb 3 = depth fill.
 */
const PALETTES: Record<AmbientSection, OrbClasses> = {
  hero: {
    orb1: "bg-gradient-to-br from-sky-300/35 via-sky-200/20 to-transparent",
    orb2: "bg-gradient-to-tr from-amber-200/30 via-amber-100/20 to-transparent",
    orb3: "bg-gradient-to-tl from-sky-200/25 via-amber-100/15 to-transparent",
  },
  challenge: {
    orb1: "bg-gradient-to-br from-indigo-400/30 via-indigo-300/20 to-transparent",
    orb2: "bg-gradient-to-tr from-emerald-300/25 via-emerald-200/15 to-transparent",
    orb3: "bg-gradient-to-tl from-indigo-300/20 via-emerald-200/15 to-transparent",
  },
  pricing: {
    orb1: "bg-gradient-to-br from-violet-400/30 via-violet-300/20 to-transparent",
    orb2: "bg-gradient-to-tr from-amber-300/35 via-amber-200/20 to-transparent",
    orb3: "bg-gradient-to-tl from-violet-300/25 via-amber-200/20 to-transparent",
  },
  faq: {
    orb1: "bg-gradient-to-br from-teal-300/30 via-teal-200/20 to-transparent",
    orb2: "bg-gradient-to-tr from-rose-300/25 via-rose-200/15 to-transparent",
    orb3: "bg-gradient-to-tl from-teal-200/25 via-rose-200/15 to-transparent",
  },
};

const ORB_TRANSITION = "transition-all duration-1000 ease-out";

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

  useEffect(() => {
    let frame = 0;

    const update = () => {
      frame = 0;
      const next = resolveActiveSection();
      setActiveSection((prev) => (prev === next ? prev : next));
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
      className="pointer-events-none fixed inset-0 overflow-hidden z-0"
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
            />
            {/* Orb 2 — Mid-left */}
            <div
              className={`absolute w-[700px] h-[700px] rounded-full blur-[110px] top-[30%] -left-32 ${ORB_TRANSITION} ${palette.orb2}`}
            />
            {/* Orb 3 — Bottom-right */}
            <div
              className={`absolute w-[650px] h-[650px] rounded-full blur-[100px] bottom-10 right-10 ${ORB_TRANSITION} ${palette.orb3}`}
            />
          </div>
        );
      })}
    </div>
  );
}
