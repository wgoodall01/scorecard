import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Camera,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Flag,
  ImageUp,
  LibraryBig,
  RefreshCcw,
  ScanText,
  Search,
  Trash2,
} from "lucide-react";
import type { CourseProposalSchema, Tee } from "api";
import { AppShell, PageTitle } from "@/App";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CameraDialog, useLikelyHasCamera } from "@/components/camera-dialog";
import { ImageExpand } from "@/components/image-expand";
import { ResponsiveSelect } from "@/components/responsive-select";
import { Stepper } from "@/components/stepper";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { resizeImageForCapture } from "@/lib/image_resize";
import { apiMutation, apiQuery, apiQueryKey } from "@/lib/query";
import { courseResearchQuery, isPending, scorecardMetadataQuery } from "@/lib/queries";
import { TEE_LABELS, TEES } from "@/lib/tees";
import { cn } from "@/lib/utils";

// The flow: pick the course, pull its layout, reconcile, review, save.
//
// "layout" is where the course's pars/yardages/stroke indexes come from. The
// default source is GolfCourseAPI, searched automatically from the facility
// name; a scorecard photo is only asked for when that feed can't stand on its
// own (see layoutGaps in the API), though it can always be added on purpose.
type FlowStep = "find" | "layout" | "analyze" | "review" | "done";

type Facility = {
  facilityId: number;
  name: string;
  state: string | null;
  country: string | null;
  existingCourseId: string | null;
};

// A GolfCourseAPI club: every rated layout it publishes, folded by the API into
// one entry per physical nine, plus whatever that leaves missing.
type Club = {
  clubName: string;
  location: string | null;
  courseIds: number[];
  ratedLayouts: (string | null)[];
  nines: { name: string | null; tees: number; holes: number }[];
  gaps: { severity: "blocking" | "advisory"; message: string }[];
};

// How long the background jobs get before the wait is called a failure.
const JOB_TIMEOUT_MS = 90_000;
const SEARCH_DEBOUNCE_MS = 250;
// The GolfCourseAPI search is debounced harder than the local USGA typeahead:
// every distinct query is an upstream request against a 50/day quota (the API
// caches each for a day, but a fresh query still spends one).
const GOLF_SEARCH_DEBOUNCE_MS = 600;

// Which club a facility most likely is. Picks an exact name match, else the
// only result — never a guess between several, since that would silently import
// the wrong course's pars.
function bestClubMatch(clubs: Club[], facilityName: string | undefined): Club | null {
  if (clubs.length === 0) return null;
  const folded = facilityName?.trim().toLowerCase();
  const exact = clubs.find((club) => club.clubName.trim().toLowerCase() === folded);
  return exact ?? (clubs.length === 1 ? clubs[0] : null);
}

export function CourseCreatePage({ editFacilityId }: { editFacilityId?: number | null }) {
  const { token } = useAuth();
  const hasCamera = useLikelyHasCamera();
  const queryClient = useQueryClient();
  // Edit mode: load an existing course straight into the editor, skipping the
  // capture/find/analyze steps.
  const editMode = editFacilityId != null;
  const [step, setStep] = useState<FlowStep>(editFacilityId != null ? "review" : "find");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Find step. The typeahead is debounced into `query`, which is part of the
  // search query's key.
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [facility, setFacility] = useState<Facility | null>(null);

  // Layout step. `golfSearch` seeds from the picked facility's name and is
  // debounced into `golfQuery`; `clubChoice` is set only when the admin picks a
  // club explicitly (otherwise the match is derived — see bestClubMatch).
  const [golfSearch, setGolfSearch] = useState<string | null>(null);
  const [golfQuery, setGolfQuery] = useState("");
  const [clubChoice, setClubChoice] = useState<Club | null>(null);

  // Review step. `edited` holds the admin's in-progress edits; until they touch
  // anything, the proposal from the server (or the existing course, in edit
  // mode) is what's shown.
  const [edited, setEdited] = useState<CourseProposalSchema | null>(null);
  const [showExisting, setShowExisting] = useState(false);

  // Both background jobs get one deadline per attempt.
  const deadlineRef = useRef(0);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  // The GolfCourseAPI search box defaults to the picked facility's name.
  const golfSearchValue = golfSearch ?? facility?.name ?? "";
  useEffect(() => {
    const timer = window.setTimeout(
      () => setGolfQuery(golfSearchValue.trim()),
      GOLF_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [golfSearchValue]);

  // 1. The facility typeahead over the USGA mirror — local, so it's free and
  // instant, which is why the flow starts here rather than at GolfCourseAPI.
  const facilitiesQuery = useQuery({
    ...apiQuery(api.courses.facilities.$get, { query: { q: query } }),
    enabled: step === "find" && query.length >= 2,
  });
  const facilities: Facility[] | null =
    query.length < 2 ? null : (facilitiesQuery.data?.facilities ?? null);

  // 2. The course's layout from GolfCourseAPI. One upstream request per distinct
  // query, so it only runs on the Layout step.
  const clubsQuery = useQuery({
    ...apiQuery(api.courses.golfcourseapi.$get, { query: { q: golfQuery } }),
    enabled: step === "layout" && golfQuery.length >= 3,
  });
  const clubs: Club[] | null = golfQuery.length < 3 ? null : (clubsQuery.data?.clubs ?? null);
  // Derived, not stored: the admin's explicit pick wins, else the obvious match.
  const club = clubChoice ?? bestClubMatch(clubs ?? [], facility?.name);
  const gaps = club?.gaps ?? [];
  const blockedOnCard =
    clubs !== null && (club === null || gaps.some((g) => g.severity === "blocking"));

  // 3. The optional scorecard photo (multipart, so it's a hand-written fetch),
  // which kicks off the vision layout extraction.
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.set("image", await resizeImageForCapture(file));
      form.set("extract", JSON.stringify({ metadata: true }));
      const response = await fetch("/api/scorecard", {
        method: "POST",
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Unable to upload.");
      return body.id;
    },
  });
  const scorecardId = uploadMutation.data ?? null;
  const uploadError = uploadMutation.error?.message ?? null;

  // The extraction poll. With no photo there's nothing to wait for.
  const metadataQuery = useQuery(scorecardMetadataQuery(scorecardId, deadlineRef.current));
  const metadataReady =
    scorecardId === null || (metadataQuery.data !== undefined && !isPending(metadataQuery.data));
  const metadataError =
    scorecardId === null
      ? null
      : (metadataQuery.error?.message ??
        (isPending(metadataQuery.data) && Date.now() >= deadlineRef.current
          ? "Reading the scorecard took too long."
          : null));

  // 4. Reconcile the layout(s) against the USGA ratings. This is a PUT behind a
  // query so it fires exactly once its inputs are ready (and once only: cached
  // forever under its key) with no effect to sequence it.
  const researchStartQuery = useQuery({
    queryKey: [
      "courses",
      "research",
      "start",
      facility?.facilityId,
      golfQuery,
      club?.courseIds.join(","),
      scorecardId,
    ],
    queryFn: async () => {
      const response = await api.courses.research.$put.call({
        json: {
          facilityId: facility!.facilityId,
          golfCourseApi: club === null ? null : { query: golfQuery, courseIds: club.courseIds },
          scorecardId,
        },
      });
      if (!response.ok) throw new Error("Unable to start course matching.");
      return (await response.json()).jobId;
    },
    enabled:
      step === "analyze" &&
      metadataReady &&
      facility !== null &&
      (club !== null || scorecardId !== null),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  // 4. …and wait for it, which lands us in Review with a proposal.
  const researchQuery = useQuery(
    courseResearchQuery(researchStartQuery.data ?? null, deadlineRef.current),
  );
  const researched =
    researchQuery.data !== undefined && !isPending(researchQuery.data)
      ? (researchQuery.data as CourseProposalSchema)
      : null;

  // The existing app course for this facility: the before/after toggle in
  // create mode, and the whole starting point in edit mode.
  const facilityId = editFacilityId ?? facility?.facilityId ?? null;
  const existingQuery = useQuery({
    ...apiQuery(api.courses.facility[":facilityId"].$get, {
      param: { facilityId: String(facilityId ?? "") },
    }),
    enabled: facilityId !== null,
  });
  const existing = existingQuery.data?.course ? toProposal(existingQuery.data.course) : null;

  const analyzeStatus = metadataReady
    ? "Matching against USGA ratings…"
    : "Reading the scorecard layout…";
  const clubsError = clubsQuery.error?.message ?? null;
  const analyzeError =
    metadataError ??
    researchStartQuery.error?.message ??
    researchQuery.error?.message ??
    (isPending(researchQuery.data) && Date.now() >= deadlineRef.current
      ? "Analyzing the course took too long."
      : null);

  const saveMutation = useMutation({
    ...apiMutation(api.courses.$post),
    onSuccess: async () => {
      // The saved course belongs in the registry (and in every picker that
      // walks it) right away.
      await queryClient.invalidateQueries({ queryKey: apiQueryKey(api.courses.$get) });
      setStep("done");
    },
  });
  const savedCourseId = saveMutation.data?.courseId ?? null;
  const saving = saveMutation.isPending;
  const reviewError =
    saveMutation.error?.message ??
    (editMode && existingQuery.error !== null ? "Couldn't load this course for editing." : null);

  // What the editor shows: the admin's edits if they've made any, else the
  // researched proposal, else (edit mode) the existing course.
  const proposal = edited ?? researched ?? (editMode ? existing : null);
  const setProposal = setEdited;

  // The researched proposal is what lands us on Review.
  const effectiveStep: FlowStep = savedCourseId
    ? "done"
    : researched !== null && step === "analyze"
      ? "review"
      : step;

  function reset() {
    setStep("find");
    setPreviewUrl(null);
    setSearch("");
    setQuery("");
    setFacility(null);
    setGolfSearch(null);
    setGolfQuery("");
    setClubChoice(null);
    setEdited(null);
    setShowExisting(false);
    uploadMutation.reset();
    saveMutation.reset();
  }

  function startCapture(file: File) {
    setPreviewUrl(URL.createObjectURL(file));
    deadlineRef.current = Date.now() + JOB_TIMEOUT_MS;
    uploadMutation.mutate(file);
  }

  // Retry the wait: push the deadline out and refetch whichever job stalled.
  function retryAnalyze() {
    deadlineRef.current = Date.now() + JOB_TIMEOUT_MS;
    if (!metadataReady) {
      void metadataQuery.refetch();
      return;
    }
    if (researchStartQuery.data === undefined) {
      void researchStartQuery.refetch();
      return;
    }
    void researchQuery.refetch();
  }

  function save() {
    if (!proposal) return;
    // Edit mode loaded the full course, so any existing nine absent from the
    // proposal was explicitly removed — archive it. (The create flow only has
    // the captured nines, so it never archives.)
    const archiveSetNames =
      editMode && existing
        ? existing.sets
            .filter(
              (existingSet) =>
                !proposal.sets.some(
                  (set) => set.name.trim().toLowerCase() === existingSet.name.trim().toLowerCase(),
                ),
            )
            .map((existingSet) => existingSet.name)
        : [];
    saveMutation.mutate({
      json: { ...proposal, scorecardId: editMode ? null : scorecardId, archiveSetNames },
    });
  }

  const busy = effectiveStep === "analyze" && !analyzeError;

  return (
    <AppShell>
      <PageTitle>{editMode ? "Edit Course · Scorecard" : "Add Course · Scorecard"}</PageTitle>
      <div className="flex flex-col gap-6">
        {!editMode && (
          <div className="sticky top-0 z-10 -mx-5 border-b bg-background/95 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-4 backdrop-blur md:-mx-10 md:px-10">
            <Stepper
              aria-label="Add course progress"
              className="max-w-md"
              current={effectiveStep}
              busy={busy}
              steps={[
                { key: "find", label: "Find", icon: Search },
                { key: "layout", label: "Layout", icon: LibraryBig },
                { key: "analyze", label: "Analyze", icon: ScanText },
                { key: "review", label: "Review", icon: ClipboardCheck },
                { key: "done", label: "Done", icon: Check },
              ]}
            />
          </div>
        )}

        {editMode && !proposal && (
          <Empty className="min-h-64 border bg-muted/30">
            <EmptyHeader>
              <EmptyMedia
                variant="icon"
                className={cn(
                  "rounded-full",
                  reviewError ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
                )}
              >
                {reviewError ? <CircleAlert /> : <Spinner className="size-5" />}
              </EmptyMedia>
              <EmptyTitle>{reviewError ? "Couldn't load course" : "Loading course…"}</EmptyTitle>
              {reviewError && <EmptyDescription>{reviewError}</EmptyDescription>}
            </EmptyHeader>
            {reviewError && (
              <EmptyContent>
                <Link className={buttonVariants({ variant: "outline" })} to="/courses">
                  Back to courses
                </Link>
              </EmptyContent>
            )}
          </Empty>
        )}

        {effectiveStep === "find" && (
          <FindStep
            query={search}
            onQuery={setSearch}
            facilities={facilities}
            selected={facility}
            onSelect={setFacility}
            onContinue={() => facility && setStep("layout")}
          />
        )}

        {effectiveStep === "layout" && (
          <LayoutStep
            facility={facility}
            query={golfSearchValue}
            onQuery={setGolfSearch}
            searching={clubsQuery.isFetching}
            clubs={clubs}
            error={clubsError}
            club={club}
            onSelectClub={setClubChoice}
            gaps={gaps}
            blockedOnCard={blockedOnCard}
            hasCamera={hasCamera}
            previewUrl={previewUrl}
            uploading={uploadMutation.isPending}
            uploadError={uploadError}
            onFile={startCapture}
            onCamera={() => setCameraOpen(true)}
            onBack={() => setStep("find")}
            onContinue={() => {
              deadlineRef.current = Date.now() + JOB_TIMEOUT_MS;
              setStep("analyze");
            }}
          />
        )}

        {effectiveStep === "analyze" && (
          <AnalyzeStep
            status={analyzeStatus}
            error={analyzeError}
            previewUrl={previewUrl}
            onRetry={retryAnalyze}
            onStartOver={reset}
          />
        )}

        {effectiveStep === "review" && proposal && (
          <ReviewStep
            proposal={proposal}
            existing={existing}
            showExisting={showExisting}
            onShowExisting={setShowExisting}
            onChange={setProposal}
            error={reviewError}
            saving={saving}
            canArchive={editMode}
            // In the create flow the sticky stepper sits above; in edit mode
            // there's none, so the nine header pins to the very top.
            stickyTopClass={editMode ? "top-0" : "top-[calc(5rem+env(safe-area-inset-top))]"}
            onSave={save}
          />
        )}

        {effectiveStep === "done" && (
          <Empty className="min-h-64 border bg-muted/30">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="rounded-full bg-primary/10 text-primary">
                <CircleCheck />
              </EmptyMedia>
              <EmptyTitle>Course saved</EmptyTitle>
              <EmptyDescription>
                The course is live — scores can now be submitted to it.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex flex-wrap justify-center gap-3">
                {savedCourseId && (
                  <Link
                    className={buttonVariants()}
                    to="/courses/$id"
                    params={{ id: savedCourseId }}
                  >
                    <Flag data-icon="inline-start" />
                    View course
                  </Link>
                )}
                <Link className={buttonVariants({ variant: "outline" })} to="/courses">
                  Back to courses
                </Link>
              </div>
            </EmptyContent>
          </Empty>
        )}

        <CameraDialog
          open={cameraOpen}
          onOpenChange={setCameraOpen}
          onCapture={startCapture}
          description="Lay the scorecard flat and capture the whole rating table."
        />
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function LayoutStep({
  facility,
  query,
  onQuery,
  searching,
  clubs,
  error,
  club,
  onSelectClub,
  gaps,
  blockedOnCard,
  hasCamera,
  previewUrl,
  uploading,
  uploadError,
  onFile,
  onCamera,
  onBack,
  onContinue,
}: {
  facility: Facility | null;
  query: string;
  onQuery: (value: string) => void;
  searching: boolean;
  clubs: Club[] | null;
  error: string | null;
  club: Club | null;
  onSelectClub: (club: Club) => void;
  gaps: { severity: "blocking" | "advisory"; message: string }[];
  blockedOnCard: boolean;
  hasCamera: boolean;
  previewUrl: string | null;
  uploading: boolean;
  uploadError: string | null;
  onFile: (file: File) => void;
  onCamera: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const hasCard = previewUrl !== null;
  // A photo satisfies a blocking gap; otherwise it's optional extra detail.
  const canContinue = (club !== null || hasCard) && (!blockedOnCard || hasCard);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="club-search">Course layout</Label>
        <p className="text-sm text-muted-foreground">
          We look up {facility?.name ?? "the course"}&rsquo;s pars, yardages, and stroke indexes in
          the GolfCourseAPI database. Its ratings come from the USGA records either way.
        </p>
        <div className="relative mt-1.5">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="club-search"
            className="pl-9"
            placeholder="Search by club name…"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        {error !== null ? (
          <p className="flex items-start gap-2 p-5 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : query.trim().length < 3 ? (
          <p className="p-5 text-sm text-muted-foreground">
            Type at least three letters to search.
          </p>
        ) : clubs === null || searching ? (
          <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Looking up the layout…
          </p>
        ) : clubs.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">
            No match in GolfCourseAPI — photograph the scorecard below instead.
          </p>
        ) : (
          <ul>
            {clubs.map((entry) => {
              const isSelected = club?.clubName === entry.clubName;
              return (
                <li key={entry.clubName} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onSelectClub(entry)}
                    className={cn(
                      "flex w-full items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50",
                      isSelected && "bg-primary/5",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{entry.clubName}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {entry.location ?? "—"}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-1.5">
                        {entry.nines.map((nine, index) => (
                          <Badge key={index} variant="secondary" className="font-normal">
                            {nine.name ?? "Unnamed"} · {nine.holes} holes · {nine.tees} tees
                          </Badge>
                        ))}
                      </span>
                    </span>
                    {isSelected && <Check className="mt-1 size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {gaps.length > 0 && (
        <div
          className={cn(
            "flex flex-col gap-2 rounded-xl border p-4 text-sm",
            blockedOnCard ? "border-destructive/40 bg-destructive/5" : "bg-muted/30",
          )}
        >
          <span className="flex items-center gap-2 font-medium">
            <CircleAlert className="size-4" />
            {blockedOnCard ? "A scorecard photo is needed" : "What the database doesn’t cover"}
          </span>
          <ul className="list-disc pl-5 text-muted-foreground">
            {gaps.map((gap, index) => (
              <li key={index}>{gap.message}</li>
            ))}
          </ul>
        </div>
      )}

      {/* The photo: required when the feed can't stand alone, optional
          otherwise (it's what supplies the nines' printed names). */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <span className="text-sm font-medium">
          Scorecard photo
          <span className="ml-1.5 font-normal text-muted-foreground">
            {blockedOnCard ? "· required" : "· optional"}
          </span>
        </span>
        {uploadError !== null && <p className="text-sm text-destructive">{uploadError}</p>}
        {hasCard ? (
          <div className="flex items-center gap-3 text-sm">
            <ImageExpand
              src={previewUrl}
              alt="Uploaded scorecard"
              className="size-14 rounded-lg border object-cover"
            />
            <span className="flex items-center gap-2 text-muted-foreground">
              {uploading ? (
                <>
                  <Spinner className="size-4" />
                  Uploading…
                </>
              ) : (
                <>
                  <CircleCheck className="size-4 text-primary" />
                  We’ll read the printed nine names off this card.
                </>
              )}
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {hasCamera && (
              <Button variant="outline" onClick={onCamera} disabled={uploading}>
                <Camera data-icon="inline-start" />
                Take a photo
              </Button>
            )}
            <label className={buttonVariants({ variant: "outline", className: "cursor-pointer" })}>
              <ImageUp data-icon="inline-start" />
              Upload an image
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                disabled={uploading}
                onChange={(event) => {
                  const [selected] = event.target.files ?? [];
                  if (selected) onFile(selected);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        )}
      </div>

      <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] -mx-5 flex items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 backdrop-blur md:bottom-0 md:-mx-10 md:px-10">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={!canContinue || uploading}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function FindStep({
  query,
  onQuery,
  facilities,
  selected,
  onSelect,
  onContinue,
}: {
  query: string;
  onQuery: (value: string) => void;
  facilities: Facility[] | null;
  selected: Facility | null;
  onSelect: (facility: Facility) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="facility-search">Find the course</Label>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="facility-search"
            className="pl-9"
            placeholder="Search USGA-rated courses by name…"
            value={query}
            autoFocus
            onChange={(event) => onQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="rounded-xl border bg-card">
        {query.trim().length < 2 ? (
          <p className="p-5 text-sm text-muted-foreground">
            Type at least two letters to search the USGA course database.
          </p>
        ) : facilities === null ? (
          <p className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Searching…
          </p>
        ) : facilities.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">No matching courses.</p>
        ) : (
          <ul>
            {facilities.map((facility) => {
              const isSelected = selected?.facilityId === facility.facilityId;
              return (
                <li key={facility.facilityId} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onSelect(facility)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-muted/50",
                      isSelected && "bg-primary/5",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{facility.name}</span>
                      <span className="block truncate text-sm text-muted-foreground">
                        {[facility.state, facility.country].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {facility.existingCourseId && <Badge variant="secondary">Imported</Badge>}
                      {isSelected && <Check className="size-4 text-primary" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected && (
        <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] -mx-5 flex items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 backdrop-blur md:bottom-0 md:-mx-10 md:px-10">
          <span className="truncate text-sm text-muted-foreground">
            {selected.name}
            {selected.existingCourseId && " · will merge into the existing course"}
          </span>
          <Button onClick={onContinue}>Continue</Button>
        </div>
      )}
    </div>
  );
}

// The waiting step: reads the scorecard layout (if still running) then matches
// it against the USGA ratings, all behind one spinner so Find and Review stay
// snappy.
function AnalyzeStep({
  status,
  error,
  previewUrl,
  onRetry,
  onStartOver,
}: {
  status: string;
  error: string | null;
  previewUrl: string | null;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  return (
    <Empty className="min-h-64 border bg-muted/30">
      <EmptyHeader>
        <EmptyMedia
          variant="icon"
          className={cn(
            "rounded-full",
            error ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
          )}
        >
          {error ? <CircleAlert /> : <Spinner className="size-5" />}
        </EmptyMedia>
        <EmptyTitle>{error ? "Analysis failed" : "Analyzing the scorecard"}</EmptyTitle>
        <EmptyDescription>{error ?? status}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {error ? (
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={onRetry}>
              <RefreshCcw data-icon="inline-start" />
              Try again
            </Button>
            <Button variant="outline" onClick={onStartOver}>
              Start over
            </Button>
          </div>
        ) : (
          previewUrl && (
            <ImageExpand
              src={previewUrl}
              alt="Scorecard being analyzed"
              className="max-h-40 rounded-xl border object-contain opacity-80"
            />
          )
        )}
      </EmptyContent>
    </Empty>
  );
}

function ReviewStep({
  proposal,
  existing,
  showExisting,
  onShowExisting,
  onChange,
  error,
  saving,
  canArchive,
  stickyTopClass,
  onSave,
}: {
  proposal: CourseProposalSchema;
  existing: CourseProposalSchema | null;
  showExisting: boolean;
  onShowExisting: (value: boolean) => void;
  onChange: (proposal: CourseProposalSchema) => void;
  error: string | null;
  saving: boolean;
  canArchive: boolean;
  stickyTopClass: string;
  onSave: () => void;
}) {
  const shown = showExisting && existing ? existing : proposal;
  const readOnly = showExisting && existing !== null;

  return (
    <div className="flex flex-col gap-6">
      {existing && (
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">This facility is already imported</p>
            <p className="text-sm text-muted-foreground">
              Saving merges into it — existing tees, nines, and scores are preserved.
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm">
            <Switch checked={showExisting} onCheckedChange={onShowExisting} />
            {showExisting ? "Existing" : "Proposed"}
          </label>
        </div>
      )}

      <CourseEditor
        value={shown}
        existing={readOnly ? null : existing}
        readOnly={readOnly}
        canArchive={canArchive}
        stickyTopClass={stickyTopClass}
        onChange={onChange}
      />

      <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] -mx-5 flex items-center justify-between gap-3 border-t bg-background/95 px-5 py-3 backdrop-blur md:bottom-0 md:-mx-10 md:px-10">
        <Link className={buttonVariants({ variant: "ghost" })} to="/courses">
          <Trash2 data-icon="inline-start" />
          Discard
        </Link>
        <div className="flex min-w-0 items-center gap-3">
          {error && <span className="truncate text-sm text-destructive">{error}</span>}
          <Button onClick={onSave} disabled={saving || readOnly}>
            {saving ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}
            {existing ? "Apply changes" : "Save course"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

// Sentinel for the nullable Category picker (the picker keys options by a
// concrete string value; this one maps to null — "Other" — in the data).
const TYPE_OTHER = "__other__";

function CourseEditor({
  value,
  existing,
  readOnly,
  canArchive,
  stickyTopClass,
  onChange,
}: {
  value: CourseProposalSchema;
  // The existing course for this facility (merge base), or null for a brand-new
  // course. Used to annotate which tees an save would upsert into.
  existing: CourseProposalSchema | null;
  readOnly: boolean;
  // Whether removed nines are archived on save (edit flow, where the full
  // course was loaded). Off in the create flow, whose proposal is only the
  // captured nines, so absence there never means "remove".
  canArchive: boolean;
  // Tailwind `top-*` class for the sticky nine header (clears the stepper in
  // the create flow; 0 in edit mode).
  stickyTopClass: string;
  onChange: (proposal: CourseProposalSchema) => void;
}) {
  function patchCourse(patch: Partial<CourseProposalSchema>) {
    onChange({ ...value, ...patch });
  }
  function removeSet(si: number) {
    // Editor-list removal only — a merge never deletes existing DB rows, this
    // just drops the nine from what gets upserted.
    onChange({ ...value, sets: value.sets.filter((_, index) => index !== si) });
  }
  function patchSet(si: number, patch: Partial<CourseProposalSchema["sets"][number]>) {
    onChange({
      ...value,
      sets: value.sets.map((set, index) => (index === si ? { ...set, ...patch } : set)),
    });
  }
  function patchTee(
    si: number,
    ti: number,
    patch: Partial<CourseProposalSchema["sets"][number]["tees"][number]>,
  ) {
    patchSet(si, {
      tees: value.sets[si].tees.map((tee, index) => (index === ti ? { ...tee, ...patch } : tee)),
    });
  }
  function patchHole(
    si: number,
    ti: number,
    hi: number,
    patch: { par?: number; yardage?: number | null; strokeIndex?: number | null },
  ) {
    patchTee(si, ti, {
      holes: value.sets[si].tees[ti].holes.map((hole, index) =>
        index === hi ? { ...hole, ...patch } : hole,
      ),
    });
  }

  // Nines present in the existing course but dropped from the edit — surfaced
  // at the bottom so the removal is visible (and restorable).
  const currentNames = new Set(value.sets.map((set) => set.name.trim().toLowerCase()));
  const removedNines = (existing?.sets ?? []).filter(
    (set) => !currentNames.has(set.name.trim().toLowerCase()),
  );

  return (
    // Vertical hierarchy by dividers + typography; only the innermost element
    // (each tee) is an outlined card.
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Course
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="course-name">Course name</Label>
          <Input
            id="course-name"
            value={value.name}
            readOnly={readOnly}
            onChange={(event) => patchCourse({ name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="course-location">Location</Label>
          <Input
            id="course-location"
            value={value.location ?? ""}
            readOnly={readOnly}
            placeholder="Optional"
            onChange={(event) => patchCourse({ location: event.target.value || null })}
          />
        </div>
        {value.ncrdbFacilityId !== null && (
          <p className="text-sm text-muted-foreground">USGA facility {value.ncrdbFacilityId}</p>
        )}
      </section>

      {value.sets.map((set, si) => {
        const existingSet =
          existing?.sets.find(
            (entry) => entry.name.trim().toLowerCase() === set.name.trim().toLowerCase(),
          ) ?? null;
        return (
          <section key={si} className="flex flex-col gap-4 border-t pt-8">
            <div
              className={cn(
                "sticky z-10 -mx-1 flex items-start gap-3 bg-background px-1 py-2",
                stickyTopClass,
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={`set-${si}-name`}>Nine</Label>
                <Input
                  id={`set-${si}-name`}
                  value={set.name}
                  readOnly={readOnly}
                  onChange={(event) => patchSet(si, { name: event.target.value })}
                />
                {set.usgaCourseId !== null && (
                  <Badge variant="secondary" className="w-fit">
                    {set.usgaCourseNine !== null
                      ? `${set.usgaCourseNine === "front" ? "Front" : "Back"} 9 of USGA ${set.usgaCourseId}`
                      : `USGA ${set.usgaCourseId}`}
                  </Badge>
                )}
              </div>
              {!readOnly && (
                <Button
                  variant="ghost"
                  aria-label={`Remove ${set.name || "nine"}`}
                  className="mt-6 size-9 shrink-0 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeSet(si)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              )}
            </div>

            {/* Group same-named tees (men's/women's variants) into one card with
                gender tabs; each variant stays a separate tee underneath.
                Grouping is by name only, so switching gender never re-sorts. */}
            {groupTees(set.tees).map((group) => (
              <TeeGroup
                key={group.key}
                group={group}
                existingTees={existingSet?.tees ?? null}
                readOnly={readOnly}
                patchTee={(ti, patch) => patchTee(si, ti, patch)}
                patchHole={(ti, hi, patch) => patchHole(si, ti, hi, patch)}
              />
            ))}
          </section>
        );
      })}

      {canArchive && removedNines.length > 0 && (
        <section className="flex flex-col gap-3 border-t pt-8">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Will remove
          </h2>
          {removedNines.map((set) => (
            <div
              key={set.name}
              className="flex items-center justify-between gap-3 rounded-lg border border-dashed p-3"
            >
              <span className="min-w-0 truncate text-sm text-muted-foreground line-through">
                {set.name}
              </span>
              <Button
                variant="ghost"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={() => onChange({ ...value, sets: [...value.sets, set] })}
              >
                Restore
              </Button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

type ProposalTee = CourseProposalSchema["sets"][number]["tees"][number];
type TeeVariant = { tee: ProposalTee; index: number };
type TeeGrouping = { key: string; variants: TeeVariant[] };

// Group a nine's tees by name so men's/women's variants of the same tee share
// one card. Men's variant first, then women's, then ungendered.
function groupTees(tees: ProposalTee[]): TeeGrouping[] {
  const groups: TeeGrouping[] = [];
  tees.forEach((tee, index) => {
    const key = tee.name.trim().toLowerCase();
    let group = groups.find((entry) => entry.key === key);
    if (!group) {
      group = { key, variants: [] };
      groups.push(group);
    }
    group.variants.push({ tee, index });
  });
  const rank = (gender: "m" | "f" | null) => (gender === "m" ? 0 : gender === "f" ? 1 : 2);
  for (const group of groups) {
    group.variants.sort((a, b) => rank(a.tee.gender) - rank(b.tee.gender));
  }
  return groups;
}

function genderLabel(gender: "m" | "f" | null): string {
  return gender === "m" ? "Men's" : gender === "f" ? "Women's" : "—";
}

function TeeGroup({
  group,
  existingTees,
  readOnly,
  patchTee,
  patchHole,
}: {
  group: TeeGrouping;
  // Tees of the matching existing nine (merge base), or null for a new course.
  existingTees: ProposalTee[] | null;
  readOnly: boolean;
  patchTee: (ti: number, patch: Partial<ProposalTee>) => void;
  patchHole: (
    ti: number,
    hi: number,
    patch: { par?: number; yardage?: number | null; strokeIndex?: number | null },
  ) => void;
}) {
  const [active, setActive] = useState(0);
  const variant = group.variants[Math.min(active, group.variants.length - 1)];
  const tee = variant.tee;
  const ti = variant.index;
  // Gender is a tab (never a dropdown); combos have no gender, so no tabs.
  const showTabs = group.variants.some((entry) => entry.tee.gender !== null);

  // Name and category identify the tee itself, not one gender variant — edit
  // every variant in the group at once.
  const setName = (name: string) =>
    group.variants.forEach((entry) => patchTee(entry.index, { name }));
  const setType = (type: Tee | null) =>
    group.variants.forEach((entry) => patchTee(entry.index, { type }));

  // What a save would upsert INTO for the active variant, if this facility is
  // already imported and a same-name/gender tee exists.
  const existingTee =
    existingTees?.find(
      (entry) =>
        entry.name.trim().toLowerCase() === tee.name.trim().toLowerCase() &&
        (entry.gender ?? null) === (tee.gender ?? null),
    ) ?? null;
  const existingSummary = existingTee
    ? `Updates the existing tee${
        existingTee.courseRating !== null && existingTee.slopeRating !== null
          ? ` · currently rating ${existingTee.courseRating.toFixed(1)}, slope ${existingTee.slopeRating}`
          : ""
      }`
    : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      {/* Shared identity — the same across a tee's gender variants. Tee name
          grows to fill so the category dropdown sits flush at the right. */}
      <div className="flex gap-3">
        <Field label="Tee" className="min-w-0 flex-1">
          <Input
            value={tee.name}
            readOnly={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Category" className="w-40 shrink-0">
          <ResponsiveSelect
            title="Tee category"
            searchable={false}
            disabled={readOnly}
            options={[
              ...TEES.map((teeType) => ({ value: teeType, label: TEE_LABELS[teeType] })),
              { value: TYPE_OTHER, label: "Other" },
            ]}
            value={tee.type ?? TYPE_OTHER}
            onValueChange={(next) =>
              setType(next == null || next === TYPE_OTHER ? null : (next as Tee))
            }
          />
        </Field>
      </div>

      {/* Gender tabs — each variant is a separate tee; the fields below belong
          to the selected one. */}
      {showTabs && (
        <div role="tablist" className="flex gap-4 border-b">
          {group.variants.map((entry, index) => (
            <button
              key={entry.index}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={cn(
                "-mb-px border-b-2 px-0.5 pb-2 text-sm font-medium transition-colors",
                index === active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {genderLabel(entry.tee.gender)}
            </button>
          ))}
        </div>
      )}

      {/* Everything below depends on the selected gender tab. */}
      <div className="flex flex-col gap-3">
        {existingSummary && <p className="text-xs text-muted-foreground">↳ {existingSummary}</p>}
        <div className="flex gap-3">
          <Field label="Rating" className="w-28">
            <Input
              inputMode="decimal"
              className="tabular-nums"
              value={tee.courseRating ?? ""}
              readOnly={readOnly}
              onChange={(event) => patchTee(ti, { courseRating: numOrNull(event.target.value) })}
            />
          </Field>
          <Field label="Slope" className="w-28">
            <Input
              inputMode="numeric"
              className="tabular-nums"
              value={tee.slopeRating ?? ""}
              readOnly={readOnly}
              onChange={(event) => patchTee(ti, { slopeRating: intOrNull(event.target.value) })}
            />
          </Field>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="p-1.5 pr-3 text-left font-medium">Hole</th>
                {tee.holes.map((hole) => (
                  <th key={hole.number} className="p-1.5 text-center font-medium">
                    {hole.number}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-1.5 pr-3 font-medium whitespace-nowrap">Par</td>
                {tee.holes.map((hole, hi) => (
                  <td key={hole.number} className="p-1">
                    <CellInput
                      value={hole.par}
                      readOnly={readOnly}
                      allowEmpty={false}
                      onChange={(next) => next !== null && patchHole(ti, hi, { par: next })}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                <td className="p-1.5 pr-3 font-medium whitespace-nowrap">Yds</td>
                {tee.holes.map((hole, hi) => (
                  <td key={hole.number} className="p-1">
                    <CellInput
                      value={hole.yardage}
                      readOnly={readOnly}
                      allowEmpty
                      onChange={(next) => patchHole(ti, hi, { yardage: next })}
                    />
                  </td>
                ))}
              </tr>
              <tr>
                {/* The printed stroke index — the hole-difficulty ranking that
                    decides where handicap strokes fall. */}
                <td className="p-1.5 pr-3 font-medium whitespace-nowrap">Hcp</td>
                {tee.holes.map((hole, hi) => (
                  <td key={hole.number} className="p-1">
                    <CellInput
                      value={hole.strokeIndex}
                      readOnly={readOnly}
                      allowEmpty
                      onChange={(next) => patchHole(ti, hi, { strokeIndex: next })}
                    />
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function CellInput({
  value,
  readOnly,
  allowEmpty,
  onChange,
}: {
  value: number | null;
  readOnly: boolean;
  // When false (par), an empty field is a transient editing state — it doesn't
  // commit, and blurring restores the last value. When true (yardage), empty
  // commits null.
  allowEmpty: boolean;
  onChange: (value: number | null) => void;
}) {
  // A local draft lets the field go empty mid-edit (backspace to clear, then
  // type) without the controlled `value` snapping the old number back.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      inputMode="numeric"
      readOnly={readOnly}
      value={draft ?? (value === null ? "" : String(value))}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const parsed = intOrNull(raw);
        if (parsed !== null) onChange(parsed);
        else if (allowEmpty && raw.trim() === "") onChange(null);
      }}
      onBlur={() => setDraft(null)}
      className="h-8 w-12 rounded-md border bg-transparent text-center text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-70"
    />
  );
}

function numOrNull(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return value.trim() === "" || Number.isNaN(parsed) ? null : parsed;
}

function intOrNull(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return value.trim() === "" || Number.isNaN(parsed) ? null : parsed;
}

// Maps an existing app course (from GET /courses/facility/:id) into the
// CourseProposal shape, so the before/after toggle can render it read-only
// with the same editor.
function toProposal(course: {
  name: string;
  location: string | null;
  ncrdbFacilityId: number | null;
  sets: {
    name: string;
    usgaCourseId: number | null;
    usgaCourseNine: "front" | "back" | null;
    tees: {
      name: string;
      gender: "m" | "f" | null;
      type: Tee | null;
      courseRating: number | null;
      slopeRating: number | null;
      usgaTeeId: number | null;
      holes: { number: number; par: number; yardage: number | null; strokeIndex: number | null }[];
    }[];
  }[];
}): CourseProposalSchema {
  return {
    name: course.name,
    location: course.location,
    ncrdbFacilityId: course.ncrdbFacilityId,
    sets: course.sets.map((set) => ({
      name: set.name,
      usgaCourseId: set.usgaCourseId,
      usgaCourseNine: set.usgaCourseNine,
      tees: set.tees.map((tee) => ({
        name: tee.name,
        gender: tee.gender,
        type: tee.type,
        courseRating: tee.courseRating,
        slopeRating: tee.slopeRating,
        usgaTeeId: tee.usgaTeeId,
        holes: tee.holes
          .slice()
          .sort((a, b) => a.number - b.number)
          .map((hole) => ({
            number: hole.number,
            par: hole.par,
            yardage: hole.yardage,
            strokeIndex: hole.strokeIndex,
          })),
      })),
    })),
  };
}
