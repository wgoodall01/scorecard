import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Ban, ChevronRight, Mail, Mars, Pencil, Search, UserRoundPlus, Venus } from "lucide-react";
import type { PlayerHandicap, Tee } from "api";
import { AppShell, PageHeading, PageTitle } from "@/App";
import { HandicapCard } from "@/components/handicap-card";
import { MultiCombobox } from "@/components/multi-combobox";
import { ResponsiveModal } from "@/components/responsive-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/lib/auth-context";
import { OutingList, type OutingListRound, type OutingSummary } from "@/pages/outings";
import { TEE_LABELS, TEES } from "@/lib/tees";

export type Golfer = {
  id: string;
  email: string | null;
  name: string | null;
  admin: boolean;
  handicap: number | null;
  preferredTee: Tee | null;
  gender: "m" | "f" | null;
  nicknames: { id: string; userId: string; nickname: string; nicknameType: string }[];
};

async function requestError(response: { json: () => Promise<unknown> }, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

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

export function GolfersPage() {
  const { client, isAdmin } = useAuth();
  const [golfers, setGolfers] = useState<Golfer[] | null>(null);
  const [search, setSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const loadGolfers = useCallback(async () => {
    if (!client) return;
    const response = await client.api.golfers.$get();
    if (!response.ok) return;
    const { golfers: loadedGolfers } = await response.json();
    setGolfers(loadedGolfers);
  }, [client]);

  useEffect(() => {
    void loadGolfers();
  }, [loadGolfers]);

  const filteredGolfers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query || !golfers) return golfers;
    return golfers.filter(
      (golfer) =>
        (golfer.name ?? "").toLowerCase().includes(query) ||
        (golfer.email ?? "").toLowerCase().includes(query) ||
        golfer.nicknames.some((entry) => entry.nickname.toLowerCase().includes(query)),
    );
  }, [golfers, search]);

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
          {golfers && filteredGolfers && filteredGolfers.length === 0 && (
            <p className="p-5 text-sm text-muted-foreground">No golfers match your search.</p>
          )}
          {filteredGolfers && filteredGolfers.length > 0 && (
            <ul>
              {filteredGolfers.map((golfer) => (
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
                        {golfer.handicap !== null && ` · ${golfer.handicap} handicap`}
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
        </section>
      </div>
      <InviteGolferDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => void loadGolfers()}
      />
    </AppShell>
  );
}

function InviteGolferDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const { client } = useAuth();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [nicknames, setNicknames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;

    setLoading(true);
    setError(null);
    try {
      const response = await client.api.golfers.invite.$post({
        json: {
          email,
          name: name.trim() || undefined,
          nicknames: nicknames.map((nickname) => ({ nickname, nicknameType: "nickname" })),
        },
      });
      if (!response.ok) throw new Error(await requestError(response, "Unable to send the invite."));
      setEmail("");
      setName("");
      setNicknames([]);
      onOpenChange(false);
      onInvited();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Unable to send the invite.");
    } finally {
      setLoading(false);
    }
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

export function GolferDetailPage({ golferId }: { golferId: string }) {
  const { client, profile, isAdmin } = useAuth();
  const [golfer, setGolfer] = useState<Golfer | null>(null);
  const [outings, setOutings] = useState<OutingSummary[] | null>(null);
  const [handicapRecord, setHandicapRecord] = useState<PlayerHandicap | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [handicap, setHandicap] = useState("");
  const [preferredTee, setPreferredTee] = useState<Tee | null>(null);
  const [gender, setGender] = useState<"m" | "f" | null>(null);
  const [nicknames, setNicknames] = useState<string[]>([]);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [updatingAdmin, setUpdatingAdmin] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const isSelf = profile?.id === golferId;
  const canEdit = isAdmin || isSelf;

  const loadGolfer = useCallback(async () => {
    if (!client) return;
    const response = await client.api.golfers[":id"].$get({ param: { id: golferId } });
    if (!response.ok) {
      setError("This golfer could not be found.");
      return;
    }
    const { golfer: loadedGolfer } = await response.json();
    setGolfer(loadedGolfer);
  }, [client, golferId]);

  useEffect(() => {
    void loadGolfer();
  }, [loadGolfer]);

  // The golfer's outing history, newest first (the API already sorts it).
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.outings
      .$get({ query: { playerId: golferId } })
      .then(async (response) => {
        if (!cancelled && response.ok) setOutings((await response.json()).outings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, golferId]);

  // The golfer's Handicap Index and its history, recomputed by the API.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.api.golfers[":id"].handicap
      .$get({ param: { id: golferId } })
      .then(async (response) => {
        if (!cancelled && response.ok) setHandicapRecord((await response.json()).handicap);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, golferId]);

  // The editor opens seeded from the CURRENT record, so abandoned edits
  // never linger into the next session with the sheet.
  function openEditor() {
    if (!golfer) return;
    setName(golfer.name ?? "");
    setEmail(golfer.email ?? "");
    setHandicap(golfer.handicap === null ? "" : String(golfer.handicap));
    setPreferredTee(golfer.preferredTee);
    setGender(golfer.gender);
    setNicknames(golfer.nicknames.map((entry) => entry.nickname));
    setProfileError(null);
    setInviteStatus(null);
    setEditOpen(true);
  }

  // Re-sends the invite email to the golfer's SAVED address (the invite
  // endpoint is idempotent on email, and admin-only).
  async function sendInvite() {
    if (!client || !golfer?.email) return;
    setInviting(true);
    setProfileError(null);
    setInviteStatus(null);
    try {
      const response = await client.api.golfers.invite.$post({
        json: { email: golfer.email },
      });
      if (!response.ok) {
        throw new Error(await requestError(response, "Unable to send the invite."));
      }
      setInviteStatus(`Invite sent to ${golfer.email}.`);
    } catch (inviteError) {
      setProfileError(
        inviteError instanceof Error ? inviteError.message : "Unable to send the invite.",
      );
    } finally {
      setInviting(false);
    }
  }

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || !golfer) return;

    setSaving(true);
    setProfileError(null);
    try {
      const parsedHandicap = handicap.trim() === "" ? null : Number.parseInt(handicap, 10);
      if (parsedHandicap !== null && Number.isNaN(parsedHandicap)) {
        throw new Error("Handicap must be a whole number.");
      }
      const response = await client.api.golfers[":id"].$patch({
        param: { id: golfer.id },
        json: {
          name: name.trim() || null,
          email: email.trim() === "" ? null : email,
          handicap: parsedHandicap,
          preferredTee,
          gender,
          nicknames: nicknames.map((nickname) => ({ nickname, nicknameType: "nickname" })),
        },
      });
      if (!response.ok) {
        throw new Error(await requestError(response, "Unable to update this golfer."));
      }
      const { golfer: updatedGolfer } = await response.json();
      setGolfer(updatedGolfer);
      setEditOpen(false);
    } catch (saveError) {
      setProfileError(
        saveError instanceof Error ? saveError.message : "Unable to update this golfer.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleAdmin(nextAdmin: boolean) {
    if (!client || !golfer) return;

    setUpdatingAdmin(true);
    setProfileError(null);
    try {
      const response = await client.api.golfers[":id"].$patch({
        param: { id: golfer.id },
        json: { admin: nextAdmin },
      });
      if (!response.ok) {
        throw new Error(await requestError(response, "Unable to update this golfer."));
      }
      const { golfer: updatedGolfer } = await response.json();
      setGolfer(updatedGolfer);
    } catch (toggleError) {
      setProfileError(
        toggleError instanceof Error ? toggleError.message : "Unable to update this golfer.",
      );
    } finally {
      setUpdatingAdmin(false);
    }
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
              <dt className="text-muted-foreground">Handicap</dt>
              <dd>{golfer.handicap ?? "Not set"}</dd>
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
              <Label htmlFor="golfer-handicap">Handicap</Label>
              <Input
                id="golfer-handicap"
                type="number"
                inputMode="numeric"
                min={-10}
                max={54}
                step={1}
                placeholder="Not set"
                value={handicap}
                onChange={(event) => setHandicap(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="golfer-tee">Preferred tee</Label>
              <Select
                items={[
                  { value: null, label: "Not set" },
                  ...TEES.map((tee) => ({ value: tee, label: TEE_LABELS[tee] })),
                ]}
                value={preferredTee}
                onValueChange={(value) => setPreferredTee(value as Tee | null)}
              >
                <SelectTrigger id="golfer-tee" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={null}>Not set</SelectItem>
                  {TEES.map((tee) => (
                    <SelectItem key={tee} value={tee}>
                      {TEE_LABELS[tee]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                disabled={updatingAdmin}
                onCheckedChange={(checked) => void toggleAdmin(checked)}
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
                onClick={() => void sendInvite()}
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
