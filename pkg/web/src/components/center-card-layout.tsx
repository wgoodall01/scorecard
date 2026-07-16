import type { ReactNode } from "react";

export function CenterCardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-muted sm:flex sm:items-center sm:justify-center sm:p-6">
      <main className="flex min-h-svh w-full flex-col gap-6 bg-background px-6 py-8 text-sm leading-loose sm:min-h-0 sm:max-w-sm sm:rounded-2xl sm:border sm:px-8 sm:py-10 sm:shadow-sm">
        {children}
      </main>
    </div>
  );
}
