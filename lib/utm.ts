/** sessionStorage key holding the campaign attribution until the student signs up. */
export const UTM_STORAGE_KEY = "utm_attribution";

/** Field names match the nullable `StudentProfile` columns. */
export type UTMAttribution = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
};

const MAX_UTM_LENGTH = 100;

const QUERY_KEYS: Record<keyof UTMAttribution, string> = {
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
};

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_UTM_LENGTH);
  return trimmed || null;
}

function attributionOrNull(attribution: UTMAttribution): UTMAttribution | null {
  return attribution.utmSource || attribution.utmMedium || attribution.utmCampaign ? attribution : null;
}

/** Reads utm_source / utm_medium / utm_campaign from a query string; null when none is present. */
export function utmFromSearchParams(params: URLSearchParams): UTMAttribution | null {
  return attributionOrNull({
    utmSource: clean(params.get(QUERY_KEYS.utmSource)),
    utmMedium: clean(params.get(QUERY_KEYS.utmMedium)),
    utmCampaign: clean(params.get(QUERY_KEYS.utmCampaign)),
  });
}

/** Validates an attribution object sent by the browser; anything malformed becomes null. */
export function parseUTMAttribution(raw: unknown): UTMAttribution | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  return attributionOrNull({
    utmSource: clean(b.utmSource),
    utmMedium: clean(b.utmMedium),
    utmCampaign: clean(b.utmCampaign),
  });
}
