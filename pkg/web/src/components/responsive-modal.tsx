import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
// One modal, two shapes: a bottom sheet on phones, a centered dialog from
// `sm:` (640px) up. The viewport is measured ONCE, at the moment the modal
// opens, and the shape stays locked until it closes — no resize listener,
// no mid-flight component swap. Use this for every app modal (golfer
// invite/edit, lightboxes, …) so mobile always gets the sheet ergonomics.
const DESKTOP_QUERY = "(min-width: 640px)";
export function ResponsiveModal({
  open,
  onOpenChange,
  title,
  description,
  hideHeader = false,
  contentClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Required for accessibility; render it invisibly with hideHeader.
  title: string;
  description?: string;
  hideHeader?: boolean;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  // Guarded render-phase state adjustment (the React "derive on change"
  // pattern): re-measure exactly when `open` flips true, keep the shape
  // through close so the exit animation doesn't morph.
  const [shape, setShape] = useState({ open: false, isDesktop: false });
  if (open !== shape.open) {
    setShape({
      open,
      isDesktop: open ? window.matchMedia(DESKTOP_QUERY).matches : shape.isDesktop,
    });
  }
  const isDesktop = shape.isDesktop;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("max-h-[85vh] overflow-y-auto", contentClassName)}>
          <DialogHeader className={cn(hideHeader && "sr-only")}>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className={cn(
          "max-h-[85dvh] gap-6 overflow-y-auto rounded-t-4xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]",
          contentClassName,
        )}
      >
        <SheetHeader className={cn("p-0", hideHeader && "sr-only")}>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}
