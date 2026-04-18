export function parseCost(text: string | null): number {
  if (!text) return Number.NaN;
  const cleaned = text.replace(/[$,\s]/g, "").trim();
  return Number.parseFloat(cleaned);
}
