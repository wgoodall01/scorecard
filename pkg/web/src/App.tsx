import { Link, type LinkProps } from "@tanstack/react-router";
import { Camera, Flag, LandPlot, NotebookText, Trophy, UserRound, Users } from "lucide-react";

// The app shell and page chrome only — page components live in src/pages/.

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <aside className="hidden w-64 border-r bg-sidebar text-sidebar-foreground md:fixed md:inset-y-0 md:left-0 md:flex md:flex-col">
        <div className="flex h-16 items-center gap-2 px-5 font-medium">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <LandPlot aria-hidden="true" />
          </span>
          Scorecard
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-3" aria-label="Main navigation">
          <NavigationLink to="/capture" icon={<Camera aria-hidden="true" />} label="Capture" />
          <NavigationLink
            to="/outings"
            icon={<NotebookText aria-hidden="true" />}
            label="Outings"
          />
          <NavigationLink to="/honors" icon={<Trophy aria-hidden="true" />} label="Honors" />
          <NavigationLink to="/courses" icon={<Flag aria-hidden="true" />} label="Courses" />
          <NavigationLink to="/golfers" icon={<Users aria-hidden="true" />} label="Golfers" />
          <NavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pt-[calc(2rem+env(safe-area-inset-top))] pb-8 md:mx-0 md:ml-64 md:px-10 md:py-10">
        {children}
      </main>
      {/* Sticky (not fixed): the shell is a flex column and <main> fills the
          height, so the nav rests at the viewport bottom on short pages and
          sticks there on tall ones — without `fixed`'s mobile
          dynamic-viewport misplacement. */}
      <nav
        className="sticky bottom-0 z-40 flex border-t bg-background/95 pt-2 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.5rem))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] backdrop-blur md:hidden"
        aria-label="Main navigation"
      >
        <MobileNavigationLink to="/capture" icon={<Camera aria-hidden="true" />} label="Capture" />
        <MobileNavigationLink
          to="/outings"
          icon={<NotebookText aria-hidden="true" />}
          label="Outings"
        />
        <MobileNavigationLink to="/honors" icon={<Trophy aria-hidden="true" />} label="Honors" />
        <MobileNavigationLink to="/courses" icon={<Flag aria-hidden="true" />} label="Courses" />
        <MobileNavigationLink to="/golfers" icon={<Users aria-hidden="true" />} label="Golfers" />
        <MobileNavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
      </nav>
    </div>
  );
}

export function PageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
  );
}

export function PageTitle({ children }: { children: string }) {
  return <title>{children}</title>;
}

function NavigationLink({
  to,
  icon,
  label,
}: {
  to: LinkProps["to"];
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      // Prefix matching keeps a tab lit on its subpaths (/outings/<id> etc.).
      activeOptions={{ exact: false }}
      className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
    >
      {icon}
      {label}
    </Link>
  );
}

function MobileNavigationLink({
  to,
  icon,
  label,
}: {
  to: LinkProps["to"];
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      // Prefix matching keeps a tab lit on its subpaths (/outings/<id> etc.).
      activeOptions={{ exact: false }}
      className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-xs font-medium text-muted-foreground transition-colors"
      activeProps={{ className: "text-primary" }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
