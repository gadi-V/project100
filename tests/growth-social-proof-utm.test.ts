import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewsSection, { formatReviewMeta } from "../components/landing/ReviewsSection";
import { clearStoredUTM, readStoredUTM } from "../lib/hooks/useUTMTracking";
import reviews from "../lib/reviews.json";
import { UTM_STORAGE_KEY, parseUTMAttribution, utmFromSearchParams } from "../lib/utm";

const ROOT = process.cwd();
const readSource = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("UTM attribution parsing", () => {
  it("reads utm_source, utm_medium and utm_campaign and ignores other parameters", () => {
    const params = new URLSearchParams("utm_source=facebook&utm_medium=cpc&utm_campaign=bagrut_2026&utm_term=x&ref=y");
    expect(utmFromSearchParams(params)).toEqual({ utmSource: "facebook", utmMedium: "cpc", utmCampaign: "bagrut_2026" });
  });

  it("keeps a partial attribution and returns null when no UTM parameter is present", () => {
    expect(utmFromSearchParams(new URLSearchParams("utm_source=tiktok"))).toEqual({
      utmSource: "tiktok",
      utmMedium: null,
      utmCampaign: null,
    });
    expect(utmFromSearchParams(new URLSearchParams("ref=home&utm_source="))).toBeNull();
  });

  it("trims, strips control characters and caps each value at 100 characters", () => {
    const parsed = parseUTMAttribution({ utmSource: "  goo\u0000gle\n ", utmCampaign: "c".repeat(300) });
    expect(parsed).toEqual({ utmSource: "google", utmMedium: null, utmCampaign: "c".repeat(100) });
  });

  it.each([null, "utm_source=facebook", 42, [], { utmSource: 1, utmMedium: {}, utmCampaign: " " }])(
    "rejects the malformed attribution %j",
    (raw) => {
      expect(parseUTMAttribution(raw)).toBeNull();
    }
  );
});

describe("UTM sessionStorage helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
    return store;
  }

  it("reads back a stored attribution and clears it", () => {
    const store = stubStorage({ [UTM_STORAGE_KEY]: JSON.stringify({ utmSource: "instagram", utmCampaign: "psycho" }) });
    expect(readStoredUTM()).toEqual({ utmSource: "instagram", utmMedium: null, utmCampaign: "psycho" });
    clearStoredUTM();
    expect(store.has(UTM_STORAGE_KEY)).toBe(false);
    expect(readStoredUTM()).toBeNull();
  });

  it("returns null for corrupted storage or when storage is unavailable", () => {
    stubStorage({ [UTM_STORAGE_KEY]: "{not json" });
    expect(readStoredUTM()).toBeNull();
    vi.stubGlobal("sessionStorage", undefined);
    expect(readStoredUTM()).toBeNull();
    expect(() => clearStoredUTM()).not.toThrow();
  });

  it("captures UTMs on every page through the root layout", () => {
    expect(readSource("app/layout.tsx")).toContain("<UTMTracker />");
    expect(readSource("components/UTMTracker.tsx")).toContain("useUTMTracking()");
    expect(readSource("lib/hooks/useUTMTracking.ts")).toContain("sessionStorage.setItem(UTM_STORAGE_KEY");
  });
});

describe("UTM columns migration", () => {
  it("adds the three nullable StudentProfile columns without touching existing data", () => {
    const dir = readdirSync(path.join(ROOT, "prisma/migrations")).find((name) => name.endsWith("_add_utm_tracking_fields"));
    expect(dir).toBeDefined();
    const sql = readSource(`prisma/migrations/${dir}/migration.sql`);
    for (const column of ["utmSource", "utmMedium", "utmCampaign"]) {
      expect(sql).toContain(`ADD COLUMN     "${column}" TEXT`);
      expect(readSource("prisma/schema.prisma")).toMatch(new RegExp(`${column}\\s+String\\?`));
    }
    expect(sql).not.toMatch(/DROP|NOT NULL|ALTER COLUMN/);
  });
});

describe("social proof reviews section", () => {
  const html = renderToStaticMarkup(createElement(ReviewsSection));

  it("has a unique id and an existing photo for every review", () => {
    expect(reviews.length).toBeGreaterThan(0);
    expect(new Set(reviews.map((r) => r.id)).size).toBe(reviews.length);
    for (const review of reviews) {
      expect(existsSync(path.join(ROOT, "public", review.imagePath)), review.imagePath).toBe(true);
    }
  });

  it("renders the first review through next/image with lazy loading and a placeholder", () => {
    expect(html).toContain(reviews[0].displayName.replaceAll("'", "&#x27;"));
    expect(html).toContain(`/_next/image?url=${encodeURIComponent(reviews[0].imagePath)}`);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain("background-image");
    expect(html).toContain("מה מספרים התלמידים שלנו");
  });

  it("never sends a student's full surname to the browser", () => {
    const publicText = reviews.map((r) => `${r.displayName} ${r.meta} ${r.text}`).join(" ");
    const surnames = reviews
      .map((r) => r.fullName.split(" ").slice(1).join(" "))
      .filter((surname) => surname.length > 1 && !surname.endsWith(".") && !publicText.includes(surname));
    expect(surnames.length).toBeGreaterThan(0);
    for (const surname of surnames) expect(html, surname).not.toContain(surname.replaceAll("'", "&#x27;"));
    expect(html).not.toContain("fullName");
  });

  it("shows a frameless carousel with small brown quote marks", () => {
    const carousel = readSource("components/landing/ReviewsCarousel.tsx");
    expect(carousel).not.toContain("liquidGlass");
    expect(html).not.toContain("liquid-glass");
    expect(html).toContain('width="29" height="25"');
    expect(html).toContain("text-[#8C5A3C]");
  });

  it("builds the author line from the name and the course or institution only", () => {
    expect(formatReviewMeta("סטודנט להנדסה | אלגברה ליניארית")).toBe("סטודנט להנדסה, אלגברה ליניארית");
    expect(formatReviewMeta("פיזיקה")).toBe("פיזיקה");
    expect(html).toContain(` — ${formatReviewMeta(reviews[0].meta)}`);
    expect(html).not.toContain(reviews[0].achievement);
  });

  it("gives every student a distinct display name", () => {
    expect(new Set(reviews.map((r) => r.displayName)).size).toBe(reviews.length);
  });

  it("keeps the reviews JSON out of client components and uses relative imports only", () => {
    const section = readSource("components/landing/ReviewsSection.tsx");
    expect(section).not.toContain('"use client"');
    expect(section).toContain('from "../../lib/reviews.json"');
    for (const client of ["components/landing/ReviewsCarousel.tsx", "components/landing/HomeLanding.tsx"]) {
      expect(readSource(client)).toContain('"use client"');
      expect(readSource(client)).not.toContain("reviews.json");
    }
    expect(readSource("app/page.tsx")).toContain("<HomeLanding reviews={<ReviewsSection />} />");
    for (const file of [
      "components/landing/ReviewsSection.tsx",
      "components/landing/ReviewsCarousel.tsx",
      "components/landing/HomeLanding.tsx",
      "components/UTMTracker.tsx",
      "lib/hooks/useUTMTracking.ts",
      "lib/utm.ts",
    ]) {
      expect(readSource(file), file).not.toContain('from "@/');
    }
    expect(readSource("tsconfig.json")).not.toContain('"@/*"');
  });
});
