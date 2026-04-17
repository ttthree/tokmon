import { useEffect, useRef, useState } from "react";

interface StatCardProps {
  label: string;
  value: string;
  testId?: string;
  /**
   * Optional numeric value used to detect deltas across refreshes.
   * When provided together with formatDelta, the card renders a small
   * floating badge showing the change (e.g. "+$0.42") and briefly
   * highlights the main value.
   */
  numericValue?: number;
  formatDelta?: (delta: number) => string;
  /** Minimum absolute delta to show a badge (avoids floating-point noise). */
  deltaEpsilon?: number;
  /**
   * Monotonically increasing token that identifies a data refresh. The
   * animation only fires when this token changes AND the numericValue
   * differs from the previous refresh. Filter changes should NOT bump
   * this token.
   */
  refreshToken?: number;
}

interface DeltaBadge {
  id: number;
  delta: number;
  text: string;
}

export function StatCard({
  label,
  value,
  testId,
  numericValue,
  formatDelta,
  deltaEpsilon = 0,
  refreshToken,
}: StatCardProps) {
  const prevNumericRef = useRef<number | undefined>(undefined);
  const prevTokenRef = useRef<number | undefined>(undefined);
  const badgeIdRef = useRef(0);
  const [badge, setBadge] = useState<DeltaBadge | null>(null);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    // No numeric tracking configured → baseline-only, never animate.
    if (numericValue === undefined || formatDelta === undefined) {
      return;
    }

    const prevToken = prevTokenRef.current;
    const prevNumeric = prevNumericRef.current;

    // First observation: just record the baseline, don't animate.
    if (prevNumeric === undefined || prevToken === undefined) {
      prevNumericRef.current = numericValue;
      prevTokenRef.current = refreshToken;
      return;
    }

    // If the refresh token did NOT change, this re-render is from a
    // filter change (or other local state), not a data refresh.
    // Silently update the baseline so the NEXT refresh compares against
    // the currently displayed value, and skip the animation.
    if (refreshToken === prevToken) {
      prevNumericRef.current = numericValue;
      return;
    }

    // Refresh token advanced → animate if value changed meaningfully.
    prevTokenRef.current = refreshToken;
    const delta = numericValue - prevNumeric;
    prevNumericRef.current = numericValue;

    if (Math.abs(delta) <= deltaEpsilon) return;

    badgeIdRef.current += 1;
    const id = badgeIdRef.current;
    setBadge({ id, delta, text: formatDelta(delta) });
    setPulse(true);

    const pulseTimer = window.setTimeout(() => setPulse(false), 600);
    const badgeTimer = window.setTimeout(() => {
      setBadge((current) => (current?.id === id ? null : current));
    }, 2200);

    return () => {
      window.clearTimeout(pulseTimer);
      window.clearTimeout(badgeTimer);
    };
  }, [numericValue, formatDelta, deltaEpsilon, refreshToken]);

  const deltaPositive = badge ? badge.delta > 0 : false;

  return (
    <div
      data-testid="stat-card"
      className="relative overflow-visible rounded-xl border p-4"
      style={{
        background: "var(--bg-panel)",
        borderColor: "var(--border)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        data-testid={testId}
        className="text-2xl font-semibold tracking-tight transition-transform duration-300"
        style={{
          color: pulse ? (deltaPositive ? "var(--accent, #10b981)" : "var(--text-primary)") : "var(--text-primary)",
          transform: pulse ? "scale(1.04)" : "scale(1)",
        }}
      >
        {value}
      </div>
      <div className="label mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>

      {badge ? (
        <span
          key={badge.id}
          data-testid={testId ? `${testId}-delta` : undefined}
          className="stat-card-delta-badge pointer-events-none absolute right-3 top-3 rounded-full px-2 py-0.5 text-xs font-semibold shadow-sm"
          style={{
            background: deltaPositive ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)",
            color: deltaPositive ? "#059669" : "#dc2626",
            border: `1px solid ${deltaPositive ? "rgba(16, 185, 129, 0.35)" : "rgba(239, 68, 68, 0.35)"}`,
          }}
        >
          {badge.text}
        </span>
      ) : null}
    </div>
  );
}
