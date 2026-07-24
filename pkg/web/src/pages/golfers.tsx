import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, ChevronRight, Mail, Mars, Pencil, Search, UserRoundPlus, Venus } from "lucide-react";
import type { PlayerHandicap, Tee } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { HandicapCard } from "@/components/handicap-card";
import { LoadMore } from "@/components/load-more";
import { MultiCombobox } from "@/components/multi-combobox";
import { ResponsiveModal } from "@/components/responsive-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSelect } from "@/components/responsive-select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { apiInfiniteQuery, apiMutation, apiQuery, apiQueryKey, pagedRecords } from "@/lib/query";
import { OutingList, type OutingListRound, type OutingSummary } from "@/pages/outings";
import { TEE_LABELS, TEES } from "@/lib/tees";

export type Golfer = {
  id: string;
  email: string | null;
  name: string | null;
  admin: boolean;
  preferredTee: Tee | null;
  gender: "m" | "f" | null;
  nicknames: { id: string; userId: string; nickname: string; nicknameType: string }[];
};

// Group the handicap record's USGA-standard rounds by outing, so the outing
// list can show per-round scores (an 18 and a 9 for a 27-hole outing)
// instead of one raw stroke total.
function roundsByOuting(handicap: PlayerHandicap | null) {
  if (!handicap) return undefined;
  const rounds = new Map<string, OutingListRound[]>();
  for (const point of handicap.timeseries) {
    const list = rounds.get(point.outingId) ?? [];
    list.push({
      setNames: point.setNames,
      strokes: point.strokes,
      holes: point.holes,
      counted: point.counted,
    });
    rounds.set(point.outingId, list);
  }
  return rounds;
}

const GOLFERS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

export function GolfersPage() {
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  // Search runs on the server (it has to — it spans pages we haven't loaded),
  // so debounce the box rather than starting a query per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const golfersQuery = useInfiniteQuery(
    apiInfiniteQuery(api.golfers.$get, {
      query: { q: query || undefined, limit: GOLFERS_PAGE_SIZE },
    }),
  );
  const golfers = pagedRecords<Golfer>(golfersQuery.data);

  return (
    <AppShell>
      <PageTitle>Golfers · Scorecard</PageTitle>
      <PageHeading
        title="Golfers"
        description="Everyone who plays in your group."
        actions={
          isAdmin ? (
            <Button className="shrink-0" onClick={() => setInviteOpen(true)}>
              <UserRoundPlus data-icon="inline-start" />
              Add Golfer
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-5">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="pl-9"
            type="search"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <section className="rounded-xl border bg-card">
          {!golfers && <p className="p-5 text-sm text-muted-foreground">Loading golfers…</p>}
          {golfers && golfers.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">
              {query ? "No golfers match your search." : "No golfers yet."}
            </p>
          )}
          {golfers && golfers.length > 0 && (
            <ul>
              {golfers.map((golfer) => (
                <li key={golfer.id} className="border-b last:border-b-0">
                  <Link
                    to="/golfers/$id"
                    params={{ id: golfer.id }}
                    className="flex items-center justify-between gap-3 p-5 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {golfer.name ?? "Unnamed"}
                        {golfer.nicknames.map((entry) => (
                          <Badge key={entry.id} variant="secondary">
                            {entry.nickname}
                          </Badge>
                        ))}
                      </p>
                      <p className="truncate text-sm text-muted-foreground">
                        {golfer.email ?? "No email"}
                        {golfer.preferredTee && ` · ${TEE_LABELS[golfer.preferredTee]} tees`}
                      </p>
                    </div>
                    {golfer.admin && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                        Admin
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <LoadMore
            hasMore={golfersQuery.hasNextPage}
            loading={golfersQuery.isFetchingNextPage}
            onLoadMore={() => void golfersQuery.fetchNextPage()}
          />
        </section>
      </div>
      <InviteGolferDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </AppShell>
  );
}

function InviteGolferDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [nicknames, setNicknames] = useState<string[]>([]);

  const inviteMutation = useMutation({
    ...apiMutation(api.golfers.invite.$post),
    onSuccess: async () => {
      setEmail("");
      setName("");
      setNicknames([]);
      onOpenChange(false);
      // The new golfer belongs at the top of the (newest-first) list.
      await queryClient.invalidateQueries({ queryKey: apiQueryKey(api.golfers.$get) });
    },
  });
  const error = inviteMutation.error?.message ?? null;
  const loading = inviteMutation.isPending;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    inviteMutation.mutate({
      json: {
        email,
        name: name.trim() || undefined,
        nicknames: nicknames.map((nickname) => ({ nickname, nicknameType: "nickname" })),
      },
    });
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title="Add a golfer"
      description="We'll create their account and email them a sign-in link."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            autoComplete="email"
            placeholder="golfer@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-name">Name</Label>
          <Input
            id="invite-name"
            type="text"
            autoComplete="name"
            placeholder="Name (optional)"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Nicknames</Label>
          <MultiCombobox
            values={nicknames}
            onChange={setNicknames}
            placeholder="Nickname or initials…"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={loading}>
          {loading ? "Sending invite…" : "Send invite"}
        </Button>
      </form>
    </ResponsiveModal>
  );
}

const GOLFER_OUTINGS_PAGE_SIZE = 20;

export function GolferDetailPage({ golferId }: { golferId: string }) {
  const { profile, isAdmin } = useAuth();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [preferredTee, setPreferredTee] = useState<Tee | null>(null);
  const [gender, setGender] = useState<"m" | "f" | null>(null);
  const [nicknames, setNicknames] = useState<string[]>([]);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const isSelf = profile?.id === golferId;
  const canEdit = isAdmin || isSelf;

  const golferQuery = useQuery(apiQuery(api.golfers[":id"].$get, { param: { id: golferId } }));
  const golfer: Golfer | null = golferQuery.data?.golfer ?? null;
  const error = golferQuery.error?.message ?? null;

  // The golfer's outing history, newest first (the API sorts and pages it).
  const outingsQuery = useInfiniteQuery(
    apiInfiniteQuery(api.outings.$get, {
      query: { playerId: golferId, limit: GOLFER_OUTINGS_PAGE_SIZE },
    }),
  );
  const outings = pagedRecords<OutingSummary>(outingsQuery.data);

  // The golfer's Handicap Index and its history, recomputed by the API.
  const handicapQuery = useQuery(
    apiQuery(api.golfers[":id"].handicap.$get, { param: { id: golferId } }),
  );
  const handicapRecord: PlayerHandicap | null = handicapQuery.data?.handicap ?? null;

  // Both edits write through the same PATCH; refetch this golfer (and the
  // list, whose row shows the same fields) from the server afterwards.
  const updateMutation = useMutation({
    ...apiMutation(api.golfers[":id"].$patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: apiQueryKey(api.golfers.$get) });
      await queryClient.invalidateQueries({
        queryKey: apiQueryKey(api.golfers[":id"].$get, { param: { id: golferId } }),
      });
    },
  });

  const inviteMutation = useMutation({
    ...apiMutation(api.golfers.invite.$post),
    onSuccess: (_data, variables) => setInviteStatus(`Invite sent to ${variables.json.email}.`),
  });

  const saving = updateMutation.isPending;
  const inviting = inviteMutation.isPending;
  const profileError = updateMutation.error?.message ?? inviteMutation.error?.message ?? null;

  // The editor opens seeded from the CURRENT record, so abandoned edits
  // never linger into the next session with the sheet.
  function openEditor() {
    if (!golfer) return;
    setName(golfer.name ?? "");
    setEmail(golfer.email ?? "");
    setPreferredTee(golfer.preferredTee);
    setGender(golfer.gender);
    setNicknames(golfer.nicknames.map((entry) => entry.nickname));
    setInviteStatus(null);
    updateMutation.reset();
    inviteMutation.reset();
    setEditOpen(true);
  }

  // Re-sends the invite email to the golfer's SAVED address (the invite
  // endpoint is idempotent on email, and admin-only).
  function sendInvite() {
    if (!golfer?.email) return;
    setInviteStatus(null);
    inviteMutation.mutate({ json: { email: golfer.email } });
  }

  function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!golfer) return;
    updateMutation.mutate(
      {
        param: { id: golfer.id },
        json: {
          name: name.trim() || null,
          email: email.trim() === "" ? null : email,
          preferredTee,
          gender,
          nicknames: nicknames.map((nickname) => ({ nickname, nicknameType: "nickname" })),
        },
      },
      { onSuccess: () => setEditOpen(false) },
    );
  }

  function toggleAdmin(nextAdmin: boolean) {
    if (!golfer) return;
    updateMutation.mutate({ param: { id: golfer.id }, json: { admin: nextAdmin } });
  }

  return (
    <AppShell>
      <PageTitle>
        {golfer ? `${golfer.name ?? golfer.email ?? "Golfer"} · Scorecard` : "Golfer · Scorecard"}
      </PageTitle>
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-1.5 text-sm">
        <Link
          to="/golfers"
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          Golfers
        </Link>
        <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="truncate font-medium">{golfer?.name ?? golfer?.email ?? "Golfer"}</span>
      </nav>
      <div className="mb-8 min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">
          {golfer?.name ?? golfer?.email ?? "Golfer"}
        </h1>
        {golfer && (
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {golfer.email ?? "No email"}
          </p>
        )}
      </div>
      {!golfer && !error && <p className="text-sm text-muted-foreground">Loading golfer…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {golfer && (
        <div className="flex flex-col gap-5">
          <section className="rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b p-5">
              <div className="flex items-center gap-2">
                <h2 className="font-medium">Profile</h2>
                {golfer.admin && (
                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    Admin
                  </span>
                )}
              </div>
              {canEdit && (
                <Button variant="outline" size="sm" aria-label="Edit golfer" onClick={openEditor}>
                  <Pencil data-icon="inline-start" />
                  Edit
                </Button>
              )}
            </div>
            <dl className="grid grid-cols-[7rem_1fr] items-baseline gap-x-4 gap-y-3 p-5 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-all">{golfer.email ?? "Not set"}</dd>
              <dt className="text-muted-foreground">Nicknames</dt>
              <dd className="flex flex-wrap gap-1.5">
                {golfer.nicknames.length > 0
                  ? golfer.nicknames.map((entry) => (
                      <Badge key={entry.id} variant="secondary">
                        {entry.nickname}
                      </Badge>
                    ))
                  : "None"}
              </dd>
              <dt className="text-muted-foreground">Preferred tee</dt>
              <dd>{golfer.preferredTee ? TEE_LABELS[golfer.preferredTee] : "Not set"}</dd>
              <dt className="text-muted-foreground">Gender</dt>
              <dd>
                {golfer.gender === "m" ? "Men's" : golfer.gender === "f" ? "Women's" : "Not set"}
              </dd>
            </dl>
            {profileError && !editOpen && (
              <p className="border-t p-5 py-3 text-sm text-destructive">{profileError}</p>
            )}
          </section>

          <HandicapCard handicap={handicapRecord} />

          <div className="flex flex-col gap-3">
            <h2 className="font-medium">Outings</h2>
            {!outings && <p className="text-sm text-muted-foreground">Loading outings…</p>}
            {outings && outings.length === 0 && (
              <p className="text-sm text-muted-foreground">No outings recorded yet.</p>
            )}
            {outings && outings.length > 0 && (
              <>
                <OutingList
                  outings={outings}
                  highlightPlayerId={golferId}
                  roundsByOuting={roundsByOuting(handicapRecord)}
                  footer={
                    <LoadMore
                      hasMore={outingsQuery.hasNextPage}
                      loading={outingsQuery.isFetchingNextPage}
                      onLoadMore={() => void outingsQuery.fetchNextPage()}
                    />
                  }
                />
                {handicapRecord?.timeseries.some((point) => point.counted) && (
                  <p className="text-xs text-muted-foreground">
                    <sub>H</sub> counts toward the current casual handicap
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <ResponsiveModal
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit golfer"
        description={isSelf ? "Update your profile." : "Update this golfer's details."}
      >
        <form className="flex flex-col gap-4" onSubmit={saveProfile}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="golfer-name">Name</Label>
            <Input
              id="golfer-name"
              type="text"
              autoComplete="name"
              placeholder="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="golfer-email">Email</Label>
            <Input
              id="golfer-email"
              type="email"
              autoComplete="email"
              placeholder="golfer@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Nicknames</Label>
            <MultiCombobox
              values={nicknames}
              onChange={setNicknames}
              placeholder="Nickname or initials…"
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="golfer-tee">Preferred tee</Label>
              <ResponsiveSelect
                id="golfer-tee"
                value={preferredTee}
                onValueChange={(value) => setPreferredTee(value)}
                options={TEES.map((tee) => ({ value: tee, label: TEE_LABELS[tee] }))}
                clearable
                placeholder="Not set"
                title="Preferred tee"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Gender</Label>
              <ButtonGroup>
                {(
                  [
                    { value: "m", label: "Men's", icon: Mars },
                    { value: "f", label: "Women's", icon: Venus },
                    { value: null, label: "Not set", icon: Ban },
                  ] as const
                ).map((option) => (
                  <Button
                    key={option.label}
                    type="button"
                    size="icon"
                    variant={gender === option.value ? "default" : "outline"}
                    aria-label={option.label}
                    aria-pressed={gender === option.value}
                    onClick={() => setGender(option.value)}
                  >
                    <option.icon aria-hidden="true" />
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          </div>
          {isAdmin && !isSelf && golfer && (
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div>
                <p className="text-sm font-medium">Admin access</p>
                <p className="text-sm text-muted-foreground">
                  Admins can invite new golfers and manage everyone's access.
                </p>
              </div>
              <Switch
                checked={golfer.admin}
                disabled={saving}
                onCheckedChange={(checked) => toggleAdmin(checked)}
              />
            </div>
          )}
          {isAdmin && golfer && (
            <div className="flex items-center justify-between gap-3 rounded-xl border p-3">
              <div>
                <p className="text-sm font-medium">Invite email</p>
                <p className="text-sm text-muted-foreground">
                  {golfer.email
                    ? `Emails a sign-in link to ${golfer.email}.`
                    : "Add and save an email first."}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={inviting || !golfer.email}
                onClick={sendInvite}
              >
                <Mail data-icon="inline-start" />
                {inviting ? "Sending…" : "Send Invite"}
              </Button>
            </div>
          )}
          {inviteStatus && <p className="text-sm text-muted-foreground">{inviteStatus}</p>}
          {profileError && <p className="text-sm text-destructive">{profileError}</p>}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </form>
      </ResponsiveModal>
    </AppShell>
  );
}
