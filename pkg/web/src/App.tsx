import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Camera,
  ChevronRight,
  LandPlot,
  LogOut,
  Mail,
  NotebookText,
  Search,
  Share,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CaptureFlow } from "@/components/capture-flow";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Switch } from "@/components/ui/switch";
import { CenterCardLayout } from "@/components/center-card-layout";
import { useAuth } from "@/lib/auth-context";
import { ApiError, authService } from "@/lib/auth";

export function CapturePage() {
  const { isAdmin } = useAuth();

  return (
    <AppShell isAdmin={isAdmin}>
      <PageTitle>Capture · Scorecard</PageTitle>
      <PageHeading title="Capture" description="Upload a scorecard to start a new round." />
      <CaptureFlow />
    </AppShell>
  );
}

export function OutingsPage() {
  const { isAdmin } = useAuth();

  return (
    <AppShell isAdmin={isAdmin}>
      <PageTitle>Outings · Scorecard</PageTitle>
      <PageHeading title="Outings" description="Your scorecard history will appear here." />
      <section className="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <NotebookText aria-hidden="true" />
        </div>
        <h2 className="mt-4 font-medium">No outings yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Capture your first scorecard to begin building your history.
        </p>
        <Link className={buttonVariants({ className: "mt-5" })} to="/">
          <Camera data-icon="inline-start" />
          Capture a scorecard
        </Link>
      </section>
    </AppShell>
  );
}

export function LoginPage({ returnTo, initialEmail }: { returnTo: string; initialEmail?: string }) {
  const { requestCode, useCode } = useAuth();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isStandalone] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      authService.setReturnTo(returnTo);
      await requestCode(email);
      setStatus("Check your email for a six-digit code or magic link.");
    } catch (requestError) {
      setError(
        requestError instanceof ApiError && requestError.status === 404
          ? "No account found for this email. Ask an admin to invite you."
          : requestError instanceof Error
            ? requestError.message
            : "Unable to send a code.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await useCode(email, code);
      window.location.assign(authService.getReturnTo());
    } catch (useCodeError) {
      setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <CenterCardLayout>
      <PageTitle>Sign in · Scorecard</PageTitle>
      <div className="flex flex-col gap-1">
        <h1 className="font-medium">Sign in</h1>
        <p>We’ll email you a six-digit code.</p>
      </div>
      {status ? (
        <form className="flex flex-col gap-6" onSubmit={verifyCode}>
          <p className="text-sm text-muted-foreground">{status}</p>
          {!isStandalone && (
            <aside className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm md:hidden">
              <p className="font-medium">Install Scorecard</p>
              <p className="mt-1 text-muted-foreground">
                In Safari, tap <Share aria-hidden="true" className="mx-0.5 inline size-4" /> Share,
                then choose <span className="font-medium text-foreground">Add to Home Screen</span>.
              </p>
            </aside>
          )}
          <InputOTP
            containerClassName="w-full justify-center"
            maxLength={6}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            value={code}
            onChange={(value) => setCode(value)}
            required
          >
            <InputOTPGroup>
              {Array.from({ length: 3 }, (_, index) => (
                <InputOTPSlot index={index} key={index} />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {Array.from({ length: 3 }, (_, index) => (
                <InputOTPSlot index={index + 3} key={index + 3} />
              ))}
            </InputOTPGroup>
          </InputOTP>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button className="w-full" type="submit" disabled={loading || code.length !== 6}>
            {loading ? "Signing in…" : "Sign in with code"}
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <div className="flex flex-col gap-3">
            <input
              className="w-full rounded-md border bg-transparent px-3 py-2"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <Button className="w-full" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Email me a code"}
          </Button>
        </form>
      )}
    </CenterCardLayout>
  );
}

export function MagicLinkPage({ email, code }: { email: string; code: string }) {
  const { useCode } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!email || !code) {
      setError("This magic link is incomplete.");
      return;
    }

    void useCode(email, code)
      .then(() => window.location.assign(authService.getReturnTo()))
      .catch((useCodeError) =>
        setError(useCodeError instanceof Error ? useCodeError.message : "Unable to sign in."),
      );
  }, [code, email, useCode]);

  return (
    <CenterCardLayout>
      <PageTitle>Signing in · Scorecard</PageTitle>
      <div className="flex flex-1 flex-col">
        <h1 className="font-medium">Signing you in…</h1>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </CenterCardLayout>
  );
}

export function MePage() {
  const { profile, profileError, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();

  function handleSignOut() {
    signOut();
    void navigate({ to: "/login", search: { returnTo: "/" }, replace: true });
  }

  return (
    <AppShell isAdmin={isAdmin}>
      <PageTitle>Me · Scorecard</PageTitle>
      <PageHeading title="Me" description="Manage your profile and account." />
      <div className="flex flex-col gap-5">
        {profileError && <p className="text-sm text-destructive">{profileError}</p>}
        {!profile && !profileError && (
          <p className="text-sm text-muted-foreground">Loading your profile…</p>
        )}
        {profile && (
          <section className="rounded-xl border bg-card">
            <div className="flex items-center gap-3 border-b p-5">
              <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <UserRound aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="font-medium">{profile.name ?? "Scorecard player"}</h2>
                <p className="truncate text-sm text-muted-foreground">{profile.email}</p>
              </div>
            </div>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 p-5 text-sm">
              <dt className="text-muted-foreground">Name</dt>
              <dd>{profile.name ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{profile.email}</dd>
            </dl>
          </section>
        )}
        <Button variant="outline" className="self-start" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Log out
        </Button>
      </div>
    </AppShell>
  );
}

export function AdminPage() {
  const { client, isAdmin } = useAuth();
  const [users, setUsers] = useState<
    { id: string; email: string; name: string | null; admin: boolean }[] | null
  >(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || !users) return users;
    return users.filter(
      (listedUser) =>
        (listedUser.name ?? "").toLowerCase().includes(query) ||
        listedUser.email.toLowerCase().includes(query),
    );
  }, [users, search]);

  const loadUsers = useCallback(async () => {
    if (!client) return;
    const response = await client.api.admin.users.$get();
    if (!response.ok) return;
    const { users: loadedUsers } = await response.json();
    setUsers(loadedUsers);
  }, [client]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;

    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const response = await client.api.admin.invite.$post({
        json: { email, name: name.trim() || undefined },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Unable to send the invite.");
      }
      setStatus(`Invited ${email}.`);
      setEmail("");
      setName("");
      await loadUsers();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Unable to send the invite.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell isAdmin={isAdmin}>
      <PageTitle>Admin · Scorecard</PageTitle>
      <PageHeading title="Admin" description="Invite new players and manage access." />
      <div className="flex flex-col gap-5">
        <section className="rounded-xl border bg-card">
          <div className="border-b p-5">
            <h2 className="flex items-center gap-2 font-medium">
              <Mail aria-hidden="true" className="size-4" />
              Invite a player
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              We'll create their account and email them a sign-in link.
            </p>
          </div>
          <form className="flex flex-col gap-3 p-5" onSubmit={submit}>
            <input
              className="w-full rounded-md border bg-transparent px-3 py-2"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <input
              className="w-full rounded-md border bg-transparent px-3 py-2"
              type="text"
              autoComplete="name"
              placeholder="Name (optional)"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {status && <p className="text-sm text-muted-foreground">{status}</p>}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="self-start" type="submit" disabled={loading}>
              {loading ? "Sending invite…" : "Send invite"}
            </Button>
          </form>
        </section>
        <section className="rounded-xl border bg-card">
          <div className="flex flex-col gap-3 border-b p-5">
            <div>
              <h2 className="font-medium">Users</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Everyone with access to Scorecard.
              </p>
            </div>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                className="w-full rounded-md border bg-transparent py-2 pr-3 pl-9"
                type="search"
                placeholder="Search by name or email"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {!users && <p className="p-5 text-sm text-muted-foreground">Loading users…</p>}
          {users && filteredUsers && filteredUsers.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">No users match your search.</p>
          )}
          {filteredUsers && filteredUsers.length > 0 && (
            <ul>
              {filteredUsers.map((listedUser) => (
                <li key={listedUser.id} className="border-b last:border-b-0">
                  <Link
                    to="/admin/users/$id"
                    params={{ id: listedUser.id }}
                    className="flex items-center justify-between gap-3 p-5 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{listedUser.name ?? "Unnamed"}</p>
                      <p className="truncate text-sm text-muted-foreground">{listedUser.email}</p>
                    </div>
                    {listedUser.admin && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                        Admin
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppShell>
  );
}

export function AdminUserPage({ userId }: { userId: string }) {
  const { client, isAdmin } = useAuth();
  const [managedUser, setManagedUser] = useState<{
    id: string;
    email: string;
    name: string | null;
    admin: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profileStatus, setProfileStatus] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const loadUser = useCallback(async () => {
    if (!client) return;
    const response = await client.api.admin.users[":id"].$get({ param: { id: userId } });
    if (!response.ok) {
      setError("This user could not be found.");
      return;
    }
    const { user: loadedUser } = await response.json();
    setManagedUser(loadedUser);
  }, [client, userId]);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  useEffect(() => {
    if (managedUser) {
      setName(managedUser.name ?? "");
      setEmail(managedUser.email);
    }
    // Only re-sync when we load a (possibly different) user, so an in-progress
    // edit here isn't clobbered by a refresh triggered from the admin switch below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedUser?.id]);

  async function toggleAdmin(nextAdmin: boolean) {
    if (!client || !managedUser) return;

    setUpdating(true);
    setError(null);
    try {
      const response = await client.api.admin.users[":id"].$patch({
        param: { id: managedUser.id },
        json: { admin: nextAdmin },
      });
      if (!response.ok) throw new Error("Unable to update this user.");
      const { user: updatedUser } = await response.json();
      setManagedUser(updatedUser);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "Unable to update this user.");
    } finally {
      setUpdating(false);
    }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !managedUser) return;

    setSavingProfile(true);
    setProfileError(null);
    setProfileStatus(null);
    try {
      const response = await client.api.admin.users[":id"].$patch({
        param: { id: managedUser.id },
        json: { name: name.trim() || null, email },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Unable to update this user.");
      }
      const { user: updatedUser } = await response.json();
      setManagedUser(updatedUser);
      setProfileStatus("Saved.");
    } catch (saveError) {
      setProfileError(
        saveError instanceof Error ? saveError.message : "Unable to update this user.",
      );
    } finally {
      setSavingProfile(false);
    }
  }

  return (
    <AppShell isAdmin={isAdmin}>
      <PageTitle>
        {managedUser ? `${managedUser.name ?? managedUser.email} · Scorecard` : "User · Scorecard"}
      </PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
        <Link to="/admin" className="text-muted-foreground transition-colors hover:text-foreground">
          Admin
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">
          {managedUser?.name ?? managedUser?.email ?? "User"}
        </span>
      </nav>
      <div className="mb-8 min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">
          {managedUser?.name ?? managedUser?.email ?? "User"}
        </h1>
        {managedUser && (
          <p className="mt-1 truncate text-sm text-muted-foreground">{managedUser.email}</p>
        )}
      </div>
      {!managedUser && !error && <p className="text-sm text-muted-foreground">Loading user…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {managedUser && (
        <div className="flex flex-col gap-5">
          <section className="rounded-xl border bg-card">
            <div className="border-b p-5">
              <h2 className="font-medium">Profile</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Update this player's name and email.
              </p>
            </div>
            <form className="flex flex-col gap-3 p-5" onSubmit={saveProfile}>
              <input
                className="w-full rounded-md border bg-transparent px-3 py-2"
                type="text"
                autoComplete="name"
                placeholder="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <input
                className="w-full rounded-md border bg-transparent px-3 py-2"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              {profileStatus && <p className="text-sm text-muted-foreground">{profileStatus}</p>}
              {profileError && <p className="text-sm text-destructive">{profileError}</p>}
              <Button className="self-start" type="submit" disabled={savingProfile}>
                {savingProfile ? "Saving…" : "Save changes"}
              </Button>
            </form>
          </section>
          <section className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 p-5">
              <div>
                <h2 className="font-medium">Admin access</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Admins can invite new players and manage everyone's access.
                </p>
              </div>
              <Switch
                checked={managedUser.admin}
                disabled={updating}
                onCheckedChange={(checked) => void toggleAdmin(checked)}
              />
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

function AppShell({ children, isAdmin }: { children: React.ReactNode; isAdmin?: boolean }) {
  return (
    <div className="min-h-svh bg-background md:flex">
      <aside className="hidden w-64 shrink-0 border-r bg-sidebar text-sidebar-foreground md:flex md:flex-col">
        <div className="flex h-16 items-center gap-2 px-5 font-medium">
          <span className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <LandPlot aria-hidden="true" />
          </span>
          Scorecard
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3 py-3" aria-label="Main navigation">
          <NavigationLink to="/" icon={<Camera aria-hidden="true" />} label="Capture" />
          <NavigationLink
            to="/outings"
            icon={<NotebookText aria-hidden="true" />}
            label="Outings"
          />
          <NavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
          {isAdmin && (
            <NavigationLink to="/admin" icon={<ShieldCheck aria-hidden="true" />} label="Admin" />
          )}
        </nav>
      </aside>
      <main className="mx-auto w-full max-w-3xl px-5 pt-[calc(2rem+env(safe-area-inset-top))] pb-[calc(6rem+env(safe-area-inset-bottom))] md:mx-0 md:px-10 md:py-10">
        {children}
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 flex border-t bg-background/95 pt-2 pb-[max(0.75rem,calc(env(safe-area-inset-bottom)+0.5rem))] pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] backdrop-blur md:hidden"
        aria-label="Main navigation"
      >
        <MobileNavigationLink to="/" icon={<Camera aria-hidden="true" />} label="Capture" />
        <MobileNavigationLink
          to="/outings"
          icon={<NotebookText aria-hidden="true" />}
          label="Outings"
        />
        <MobileNavigationLink to="/me" icon={<UserRound aria-hidden="true" />} label="Me" />
        {isAdmin && (
          <MobileNavigationLink
            to="/admin"
            icon={<ShieldCheck aria-hidden="true" />}
            label="Admin"
          />
        )}
      </nav>
    </div>
  );
}

function PageHeading({ title, description }: { title: string; description: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </header>
  );
}

function PageTitle({ children }: { children: string }) {
  return <title>{children}</title>;
}

function NavigationLink({
  to,
  icon,
  label,
}: {
  to: "/" | "/outings" | "/me" | "/admin";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
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
  to: "/" | "/outings" | "/me" | "/admin";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: true }}
      className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg py-1.5 text-xs font-medium text-muted-foreground transition-colors"
      activeProps={{ className: "text-primary" }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
