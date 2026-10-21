/** First whitespace-delimited word, or "" when the name is missing. */
function firstWord(fullName: string | null | undefined): string {
  if (typeof fullName !== "string") return "";
  const trimmed = fullName.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

/**
 * Stream display name shared by lesson reconcile and, later, the classroom chat.
 * A missing name uses the same placeholder the booking path already stores.
 */
export function streamDisplayName(fullName: string | null | undefined, id: string): string {
  const word = firstWord(fullName);
  if (!word) return `User ${id.slice(0, 4)}`;
  return `${word} (${id.slice(0, 4)})`;
}
