import { Check, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type StepperStep<K extends string> = {
  key: K;
  label: string;
  icon: LucideIcon;
};

/**
 * Horizontal stepper: a row of stages joined by connector lines, with labels
 * under each node. Completed stages show a check; the current stage shows its
 * icon, or a spinner while `busy`.
 */
export function Stepper<K extends string>({
  steps,
  current,
  busy,
  className,
  ...props
}: React.ComponentProps<"ol"> & {
  steps: StepperStep<K>[];
  current: K;
  /** Show a spinner in the current step's node (e.g. while it works). */
  busy?: boolean;
}) {
  const currentIndex = steps.findIndex((step) => step.key === current);

  return (
    <ol className={cn("flex items-start", className)} {...props}>
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";

        return (
          <li key={step.key} className={cn("flex items-start", index > 0 && "flex-1")}>
            {index > 0 && (
              <div
                aria-hidden="true"
                className={cn(
                  "mx-2 mt-[17px] h-0.5 flex-1 rounded-full transition-colors",
                  state === "upcoming" ? "bg-border" : "bg-primary",
                )}
              />
            )}
            <div
              className="flex flex-col items-center gap-1"
              aria-current={state === "current" ? "step" : undefined}
            >
              <div
                className={cn(
                  "flex size-9 items-center justify-center rounded-full border transition-colors",
                  state === "complete" && "border-primary bg-primary text-primary-foreground",
                  state === "current" && "border-primary bg-primary/10 text-primary",
                  state === "upcoming" && "border-border bg-background text-muted-foreground",
                )}
              >
                {state === "complete" ? (
                  <Check className="size-4" />
                ) : state === "current" && busy ? (
                  <Spinner />
                ) : (
                  <step.icon className="size-4" />
                )}
              </div>
              <span
                className={cn(
                  "text-xs font-medium",
                  state === "upcoming" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {step.label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
