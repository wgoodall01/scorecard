import { Check, type LucideIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type StepperStep<K extends string> = {
  key: K;
  label: string;
  icon: LucideIcon;
  /** Rendered inside the step's section while the step is current. */
  content?: React.ReactNode;
};

/**
 * Vertical stepper: a rail of numbered stages where the current stage expands
 * to show its content inline, indented under its label.
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
    <ol className={cn("flex flex-col", className)} {...props}>
      {steps.map((step, index) => {
        const state =
          index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        const isLast = index === steps.length - 1;

        return (
          <li
            key={step.key}
            className="grid grid-cols-[2.25rem_1fr] gap-x-4"
            aria-current={state === "current" ? "step" : undefined}
          >
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors",
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
              {!isLast && (
                <div
                  aria-hidden="true"
                  className={cn(
                    "min-h-4 w-0.5 flex-1 rounded-full transition-colors",
                    state === "complete" ? "bg-primary" : "bg-border",
                  )}
                />
              )}
            </div>
            <div className={cn("flex min-w-0 flex-col", !isLast && "pb-6")}>
              <div className="flex min-h-9 items-center">
                <span
                  className={cn(
                    "text-sm font-medium",
                    state === "upcoming" ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {step.label}
                </span>
              </div>
              {state === "current" && step.content && (
                <div className="mt-2 min-w-0">{step.content}</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
