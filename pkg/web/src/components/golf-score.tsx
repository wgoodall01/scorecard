import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Standard golf scorecard notation, relative to par:
//   circle = birdie · double circle = eagle or better
//   square = bogey  · double square = double bogey or worse
//   plain  = par
// The double ring is drawn with a ring offset, so these classes assume the
// cell sits on the card background.
function notationClass(delta: number): string {
  if (delta === 0) return "";
  if (delta === -1) return "rounded-full border border-foreground/60";
  if (delta <= -2) {
    return "rounded-full border border-foreground/60 ring-1 ring-foreground/60 ring-offset-2 ring-offset-card";
  }
  if (delta === 1) return "rounded-sm border border-foreground/60";
  return "rounded-sm border border-foreground/60 ring-1 ring-foreground/60 ring-offset-2 ring-offset-card";
}

// One score cell in golf notation. Read-only by default; pass `onChange` to
// get an editable numeric input carrying the same notation.
export function GolfScore({
  score,
  par,
  onChange,
  className,
  "aria-label": ariaLabel,
}: {
  score: number | null;
  par: number;
  onChange?: (raw: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const delta = score === null ? null : score - par;
  const notation = delta === null ? "" : notationClass(delta);

  if (!onChange) {
    if (score === null) {
      return (
        <span aria-label={ariaLabel} className={cn("text-muted-foreground", className)}>
          –
        </span>
      );
    }
    return (
      <span
        aria-label={ariaLabel}
        className={cn(
          "inline-flex size-6 items-center justify-center tabular-nums",
          notation,
          className,
        )}
      >
        {score}
      </span>
    );
  }

  return (
    <Input
      aria-label={ariaLabel}
      type="number"
      inputMode="numeric"
      min={1}
      placeholder="–"
      value={score ?? ""}
      onChange={(event) => onChange(event.target.value)}
      className={cn("h-9 w-14 text-center", notation, className)}
    />
  );
}
