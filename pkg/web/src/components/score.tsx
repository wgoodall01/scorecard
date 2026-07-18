import { cn } from "@/lib/utils";

// Unified typography for score TOTALS (per-hole cells render through
// GolfScore's golf notation instead). Two optional markers:
// - `incomplete`: superscript "+" — the total doesn't cover every hole, so
//   it isn't comparable to complete rounds.
// - `inHandicap`: subscript "H" — the round is averaged into the current
//   casual handicap.
export function Score({
  value,
  inHandicap = false,
  incomplete = false,
  className,
}: {
  value: number | null;
  inHandicap?: boolean;
  incomplete?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      {value ?? "–"}
      {incomplete && (
        <sup
          className="text-[0.65em] font-medium text-muted-foreground"
          title="Not every hole has a recorded score"
          aria-label="incomplete round"
        >
          +
        </sup>
      )}
      {inHandicap && (
        <sub
          className="text-[0.65em] font-medium text-muted-foreground"
          title="Counts toward the current casual handicap"
          aria-label="counts toward the casual handicap"
        >
          H
        </sub>
      )}
    </span>
  );
}
