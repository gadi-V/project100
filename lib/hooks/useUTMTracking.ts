"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { UTM_STORAGE_KEY, parseUTMAttribution, utmFromSearchParams, type UTMAttribution } from "../utm";

/** Attribution saved earlier in this browser tab, or null. */
export function readStoredUTM(): UTMAttribution | null {
  try {
    return parseUTMAttribution(JSON.parse(sessionStorage.getItem(UTM_STORAGE_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function clearStoredUTM(): void {
  try {
    sessionStorage.removeItem(UTM_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): nothing was saved.
  }
}

/**
 * Saves utm_* parameters from the current URL to sessionStorage. A later campaign link in the same tab
 * replaces the earlier one; pages without utm_* parameters keep what is stored.
 */
export function useUTMTracking(): void {
  const pathname = usePathname();

  useEffect(() => {
    const attribution = utmFromSearchParams(new URLSearchParams(window.location.search));
    if (!attribution) return;
    try {
      sessionStorage.setItem(UTM_STORAGE_KEY, JSON.stringify(attribution));
    } catch {
      // Storage blocked (private mode): the sign-up simply carries no attribution.
    }
  }, [pathname]);
}
