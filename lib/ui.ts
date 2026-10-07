/**
 * Ruri Liquid Frosted Glass — shared class tokens.
 * Cards must stay translucent so ambient mesh orbs in AmbientCanvas read through.
 */

/** Ambient page canvas — transparent; orbs + base tone live in root layout */
export const pageCanvas = "min-h-screen text-neutral-900";

/** Universal liquid glass surface (Ruri backdrop-filter model) */
export const liquidGlass = "liquid-glass rounded-3xl";

/** Frosted surface card — alias of liquid glass with hover lift */
export const frostCard =
  "liquid-glass rounded-3xl hover:-translate-y-0.5 hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.08)] transition-all duration-200 ease-out";

/** Compact frost panel (tables, sidebars, drawers) */
export const frostPanel =
  "liquid-glass rounded-xl";

/** Sticky frosted app header / nav strip */
export const frostHeader =
  "bg-white/55 backdrop-blur-[24px] backdrop-saturate-[190%] border-b border-white/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]";

/** Selected / recommended card — crisp primary border on liquid glass */
export const frostCardSelected =
  "liquid-glass-selected rounded-3xl transition-all duration-200";

/** Primary CTA — solid high-contrast black pill */
export const primaryCta =
  "bg-neutral-900 text-white hover:bg-neutral-800 active:scale-[0.98] rounded-full py-3 px-6 font-medium shadow-sm transition-all duration-150 ease-out disabled:opacity-40";

/** Secondary CTA — translucent outlined pill (no opaque white cardboard) */
export const secondaryCta =
  "border border-neutral-300/80 bg-white/45 backdrop-blur-md text-neutral-800 hover:bg-white/70 active:scale-[0.98] rounded-full py-3 px-6 font-medium transition-all duration-150 ease-out disabled:opacity-40";

/** Lead capture & registration CTA — every sign-up / leave-details button is orange */
export const orangeCta =
  "bg-orange-500 hover:bg-orange-600 text-white font-bold shadow-lg shadow-orange-500/25 active:scale-[0.98] transition-all duration-150 ease-out disabled:opacity-60";

/** Secondary action inside lead / registration flows (back, change step) */
export const orangeOutlineCta =
  "border border-orange-300 bg-white/60 text-orange-700 hover:bg-orange-50 hover:border-orange-400 active:scale-[0.98] font-medium transition-all duration-150 ease-out disabled:opacity-50";

/** Selected option card / chip inside lead / registration flows */
export const orangeOptionSelected = "border-orange-500 bg-orange-50 text-orange-900 shadow-sm";

/** Destructive / caution outline pill */
export const dangerCta =
  "border border-red-200 bg-white hover:bg-red-50 text-red-700 active:scale-[0.98] rounded-full py-3 px-6 font-medium transition-all duration-150 ease-out disabled:opacity-40";

/** Form field — RTL-friendly text-start under dir="rtl" */
export const fieldClass =
  "w-full bg-neutral-50/90 border border-neutral-200 rounded-xl px-4 py-3 text-sm font-medium text-neutral-900 placeholder:text-neutral-400 text-start focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-neutral-900/[0.08] focus-visible:border-neutral-800 transition-all duration-150 disabled:opacity-50";

/** Soft status pills */
export const badgeNeutral =
  "inline-flex items-center rounded-full bg-neutral-100 text-neutral-800 text-xs font-semibold px-3 py-1";
export const badgeSuccess =
  "inline-flex items-center rounded-full bg-emerald-50 text-emerald-800 text-xs font-semibold px-3 py-1";
export const badgeWarning =
  "inline-flex items-center rounded-full bg-amber-50 text-amber-800 text-xs font-semibold px-3 py-1";
export const badgeDanger =
  "inline-flex items-center rounded-full bg-red-50 text-red-800 text-xs font-semibold px-3 py-1";

/** Empty-state widget */
export const emptyState =
  "bg-neutral-50/80 border border-neutral-200 rounded-2xl p-8 text-center space-y-3";

/** Fintech / super-override ledger surface — high contrast, serious */
export const ledgerCard =
  "bg-neutral-950 text-neutral-50 border border-neutral-800 rounded-2xl shadow-sm";

/** Eyebrow / section label */
export const eyebrow =
  "text-xs font-medium uppercase tracking-widest text-neutral-500";

/** Enterprise data row */
export const dataRow =
  "border-b border-neutral-100 last:border-b-0 px-5 py-4 hover:bg-neutral-50/80 transition-colors";

/** Frosted skeleton shimmer for loading states */
export const skeletonShimmer = "skeleton-shimmer";
