import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

// A container framed in diagonal hazard stripes, for dev-only / dangerous
// surfaces that must never be mistaken for normal UI (e.g. the local sign-in
// bypass). The striped frame wraps a solid inner panel so the content stays
// readable; an optional `label` rides in the top border.
export function CautionStripe({
  label,
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("rounded-xl p-2", className)}
      // Amber/near-black diagonal hazard tape. Fixed colors (not theme tokens)
      // — the warning should read identically in light and dark.
      style={{
        backgroundImage: "repeating-linear-gradient(45deg, #f59e0b 0 12px, #1c1917 12px 24px)",
      }}
    >
      {label && (
        <p className="flex items-center gap-1.5 px-1 py-1 text-xs font-semibold tracking-wide text-white uppercase drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]">
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          {label}
        </p>
      )}
      <div className="rounded-lg bg-background p-4">{children}</div>
    </div>
  );
}
