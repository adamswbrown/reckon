/**
 * HTML escaping primitives. Tiny, no-dep, used by every renderer.
 *
 * The cardinal rule: ANY string that flows from invoice/findings into HTML
 * MUST go through `esc()`. Customer names, RG names, meter names, etc. are
 * all attacker-controllable from the perspective of this engine. We are
 * generating a self-contained file the user will hand to a customer —
 * there must be no path from a malicious cell value to executable HTML.
 */

export function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escAttr(s: string | number | null | undefined): string {
  return esc(s);
}

/** Format a money amount for display. Adds locale grouping, fixed 0/2dp. */
export function fmtMoney(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return "—";
  const sym = currency === "USD" ? "$" : currency === "GBP" ? "£" : currency === "EUR" ? "€" : "";
  return `${sym}${amount.toLocaleString(undefined, {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtMoneyRange(
  range: [number, number] | undefined,
  currency: string
): string {
  if (!range) return "—";
  return `${fmtMoney(range[0], currency)}–${fmtMoney(range[1], currency)}`;
}
