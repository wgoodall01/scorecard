import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Camera,
  Check,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  Flag,
  ImageUp,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CameraDialog, useLikelyHasCamera } from "@/components/camera-dialog";
import { ImageExpand } from "@/components/image-expand";
import { Stepper } from "@/components/stepper";
import { useAuth } from "@/lib/auth-context";
import { resizeImageForCapture } from "@/lib/image_resize";
import { TEE_LABELS, TEES } from "@/lib/tees";
import { cn } from "@/lib/utils";

type FlowStep = "capture" | "find" | "analyze" | "review" | "done";

type Facility = {
  facilityId: number;
  name: string;
  state: string | null;
  country: string | null;
  existingCourseId: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export function CourseCreatePage({ editFacilityId }: { editFacilityId?: number | null }) {
  const { token, client } = useAuth();
  const hasCamera = useLikelyHasCamera();
  // Edit mode: load an existing course straight into the editor, skipping the
  // capture/find/analyze steps.
  const editMode = editFacilityId != null;
  // Guards the poll loops so they stop after unmount. Set true on mount (not
  // just false on cleanup) so React StrictMode's mount→cleanup→mount cycle
  // doesn't leave it stuck false and skip polling entirely.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const [step, setStep] = useState<FlowStep>(editFacilityId != null ? "review" : "capture");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [scorecardId, setScorecardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The scorecard metadata extraction runs in the background from upload while
  // the admin searches; the Analyze step waits on these refs (refs, not state,
  // so the analyze loop can poll them without re-render churn).
  const metadataReadyRef = useRef(false);
  const metadataErrorRef = useRef<string | null>(null);

  // Find step.
  const [query, setQuery] = useState("");
  const [facilities, setFacilities] = useState<Facility[] | null>(null);
  const [facility, setFacility] = useState<Facility | null>(null);

  // Analyze step (all the waiting: metadata extraction + USGA matching).
  const [analyzeStatus, setAnalyzeStatus] = useState("");
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const analyzeStartedRef = useRef(false);

  // Review step.
  const [proposal, setProposal] = useState<CourseProposalSchema | null>(null);
  const [existing, setExisting] = useState<CourseProposalSchema | null>(null);
  const [showExisting, setShowExisting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  // Debounced facility typeahead against the USGA mirror.
  useEffect(() => {
    if (step !== "find" || !client) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setFacilities(null);
      return;
    }
    let cancelled = false;
    setFacilities(null);
    const timer = window.setTimeout(async () => {
      try {
        const response = await client.api.courses.facilities.$get({ query: { q: trimmed } });
        if (cancelled) return;
        setFacilities(response.ok ? (await response.json()).facilities : []);
      } catch {
        if (!cancelled) setFacilities([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, step, client]);

  // Edit mode: load the existing course for the facility into the editor.
  useEffect(() => {
    if (editFacilityId == null || !client) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await client.api.courses.facility[":facilityId"].$get({
          param: { facilityId: String(editFacilityId) },
        });
        if (cancelled) return;
        const body = response.ok ? await response.json() : null;
        if (!body?.course) throw new Error("not found");
        const loaded = toProposal(body.course);
        setProposal(loaded);
        setExisting(loaded);
      } catch {
        if (!cancelled) setReviewError("Couldn't load this course for editing.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editFacilityId, client]);

  // Entering the Analyze step runs the whole waiting pipeline once (guarded so
  // StrictMode / re-renders don't double-fire it).
  useEffect(() => {
    if (step !== "analyze") {
      analyzeStartedRef.current = false;
      return;
    }
    if (analyzeStartedRef.current) return;
    analyzeStartedRef.current = true;
    void runAnalyze();
    // runAnalyze reads facility/scorecardId from state closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function reset() {
    setStep("capture");
    setPreviewUrl(null);
    setScorecardId(null);
    setError(null);
    metadataReadyRef.current = false;
    metadataErrorRef.current = null;
    setQuery("");
    setFacilities(null);
    setFacility(null);
    setAnalyzeStatus("");
    setAnalyzeError(null);
    setProposal(null);
    setExisting(null);
    setShowExisting(false);
    setReviewError(null);
    setSavedCourseId(null);
  }

  function startCapture(file: File) {
    setPreviewUrl(URL.createObjectURL(file));
    void upload(file);
  }

  async function upload(file: File) {
    if (!token) return;
    setError(null);
    try {
      const form = new FormData();
      form.set("image", await resizeImageForCapture(file));
      form.set("extract", JSON.stringify({ metadata: true }));
      const response = await fetch("/api/scorecard", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !body.id)
        throw new Error(body.error ?? "Unable to upload the scorecard.");
      setScorecardId(body.id);
      setStep("find");
      void pollMetadata(body.id);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload.");
    }
  }

  async function pollMetadata(id: string) {
    for (let attempt = 0; attempt < 80 && aliveRef.current; attempt++) {
      try {
        const response = await fetch(`/api/scorecard/${encodeURIComponent(id)}/metadata`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === 202) {
          await sleep(1000);
          continue;
        }
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          metadataErrorRef.current = body.error ?? "Couldn't read the scorecard.";
          return;
        }
        metadataReadyRef.current = true;
        return;
      } catch {
        await sleep(1000);
      }
    }
    if (aliveRef.current) metadataErrorRef.current = "Reading the scorecard took too long.";
  }

  // The Analyze step: wait out the scorecard layout extraction (kicked off at
  // upload), then run + poll the USGA matching, landing on Review with a ready
  // proposal. All the slowness lives here so Find and Review stay instant.
  async function runAnalyze() {
    if (!client || !facility || !scorecardId) return;
    setAnalyzeError(null);
    setProposal(null);
    setExisting(null);
    setShowExisting(false);
    setReviewError(null);

    // 1. Scorecard layout extraction.
    setAnalyzeStatus("Reading the scorecard layout…");
    while (aliveRef.current && !metadataReadyRef.current && !metadataErrorRef.current) {
      await sleep(400);
    }
    if (!aliveRef.current) return;
    if (metadataErrorRef.current) {
      setAnalyzeError(metadataErrorRef.current);
      return;
    }

    // 2. USGA matching (research). Load any existing course alongside for the
    // before/after toggle.
    setAnalyzeStatus("Matching against USGA ratings…");
    void loadExisting(facility.facilityId);
    let jobId: string;
    try {
      const response = await client.api.courses.research.$put({
        json: { scorecardId, facilityId: facility.facilityId },
      });
      if (!response.ok) throw new Error("Unable to start course matching.");
      jobId = (await response.json()).jobId;
    } catch (researchError) {
      setAnalyzeError(
        researchError instanceof Error ? researchError.message : "Unable to match the course.",
      );
      return;
    }

    for (let attempt = 0; attempt < 80 && aliveRef.current; attempt++) {
      try {
        const response = await fetch(`/api/courses/research/${encodeURIComponent(jobId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.status === 202) {
          await sleep(1000);
          continue;
        }
        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          setAnalyzeError(body.error ?? "Couldn't reconcile the course.");
          return;
        }
        setProposal((await response.json()) as CourseProposalSchema);
        setStep("review");
        return;
      } catch {
        await sleep(1000);
      }
    }
    if (aliveRef.current) setAnalyzeError("Analyzing the course took too long.");
  }

  async function loadExisting(facilityId: number) {
    if (!client) return;
    try {
      const response = await client.api.courses.facility[":facilityId"].$get({
        param: { facilityId: String(facilityId) },
      });
      if (!response.ok) return;
      const body = await response.json();
      if (body.course) setExisting(toProposal(body.course));
    } catch {
      // best-effort — the toggle just won't show
    }
  }

  async function save() {
    if (!client || !proposal) return;
    setSaving(true);
    setReviewError(null);
    try {
      // Edit mode loaded the full course, so any existing nine absent from the
      // proposal was explicitly removed — archive it. (The create flow only has
      // the captured nines, so it never archives.)
      const archiveSetNames =
        editMode && existing
          ? existing.sets
              .filter(
                (existingSet) =>
                  !proposal.sets.some(
                    (set) =>
                      set.name.trim().toLowerCase() === existingSet.name.trim().toLowerCase(),
                  ),
              )
              .map((existingSet) => existingSet.name)
          : [];
      const response = await client.api.courses.$post({
        json: { ...proposal, scorecardId: editMode ? null : scorecardId, archiveSetNames },
      });
      const body = (await response.json()) as { courseId?: string; error?: string };
      if (!response.ok || !body.courseId) throw new Error(body.error ?? "Unable to save.");
      setSavedCourseId(body.courseId);
      setStep("done");
    } catch (saveError) {
      setReviewError(saveError instanceof Error ? saveError.message : "Unable to save the course.");
    } finally {
      setSaving(false);
    }
  }

  const busy = step === "analyze" && !analyzeError;

  return (
    <AppShell>
      <PageTitle>{editMode ? "Edit Course · Scorecard" : "Add Course · Scorecard"}</PageTitle>
      <div className="flex flex-col gap-6">
        {!editMode && (
          <div className="sticky top-0 z-10 -mx-5 border-b bg-background/95 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-4 backdrop-blur md:-mx-10 md:px-10">
            <Stepper
              aria-label="Add course progress"
              className="max-w-md"
              current={step}
              busy={busy}
              steps={[
                { key: "capture", label: "Capture", icon: Camera },
                { key: "find", label: "Find", icon: Search },
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

        {step === "capture" && (
          <CaptureStep
            hasCamera={hasCamera}
            error={error}
            onFile={startCapture}
            onCamera={() => setCameraOpen(true)}
            onRetry={reset}
          />
        )}

        {step === "find" && (
          <FindStep
            query={query}
            onQuery={setQuery}
            facilities={facilities}
            selected={facility}
            onSelect={setFacility}
            onContinue={() => facility && setStep("analyze")}
            previewUrl={previewUrl}
          />
        )}

        {step === "analyze" && (
          <AnalyzeStep
            status={analyzeStatus}
            error={analyzeError}
            previewUrl={previewUrl}
            onRetry={() => void runAnalyze()}
            onStartOver={reset}
          />
        )}

        {step === "review" && proposal && (
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

        {step === "done" && (
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

function CaptureStep({
  hasCamera,
  error,
  onFile,
  onCamera,
  onRetry,
}: {
  hasCamera: boolean;
  error: string | null;
  onFile: (file: File) => void;
  onCamera: () => void;
  onRetry: () => void;
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
          {error ? <CircleAlert /> : <Camera />}
        </EmptyMedia>
        <EmptyTitle>{error ? "Upload failed" : "Photograph the scorecard"}</EmptyTitle>
        <EmptyDescription>
          {error ??
            "Capture the printed rating table (nine names, tees, pars, and yardages). We’ll read the layout while you find the course."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {error ? (
          <Button onClick={onRetry}>
            <RefreshCcw data-icon="inline-start" />
            Start over
          </Button>
        ) : (
          <div className="flex w-full max-w-60 flex-col gap-3">
            {hasCamera && (
              <Button onClick={onCamera}>
                <Camera data-icon="inline-start" />
                Take a photo
              </Button>
            )}
            <label
              className={buttonVariants({
                variant: hasCamera ? "outline" : "default",
                className: "cursor-pointer",
              })}
            >
              <ImageUp data-icon="inline-start" />
              Upload an image
              <input
                className="sr-only"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const [selected] = event.target.files ?? [];
                  if (selected) onFile(selected);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        )}
      </EmptyContent>
    </Empty>
  );
}

function FindStep({
  query,
  onQuery,
  facilities,
  selected,
  onSelect,
  onContinue,
  previewUrl,
}: {
  query: string;
  onQuery: (value: string) => void;
  facilities: Facility[] | null;
  selected: Facility | null;
  onSelect: (facility: Facility) => void;
  onContinue: () => void;
  previewUrl: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {previewUrl && (
        <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3 text-sm">
          <ImageExpand
            src={previewUrl}
            alt="Uploaded scorecard"
            className="size-14 rounded-lg border object-cover"
          />
          <span className="text-muted-foreground">
            Which course is this? We’ll match its ratings next.
          </span>
        </div>
      )}

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

// Sentinel for the nullable Category select (Base UI needs a concrete option
// value; this maps to null — "Other" — in the data).
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
    patch: { par?: number; yardage?: number | null },
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
  patchHole: (ti: number, hi: number, patch: { par?: number; yardage?: number | null }) => void;
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
        <Field label="Category">
          <Select
            // items lets Base UI's SelectValue render the label (not the raw
            // value) for the closed trigger.
            items={[
              ...TEES.map((teeType) => ({ value: teeType, label: TEE_LABELS[teeType] })),
              { value: TYPE_OTHER, label: "Other" },
            ]}
            disabled={readOnly}
            value={tee.type ?? TYPE_OTHER}
            onValueChange={(next) => setType(next === TYPE_OTHER ? null : (next as Tee))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEES.map((teeType) => (
                <SelectItem key={teeType} value={teeType}>
                  {TEE_LABELS[teeType]}
                </SelectItem>
              ))}
              <SelectItem value={TYPE_OTHER}>Other</SelectItem>
            </SelectContent>
          </Select>
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
      holes: { number: number; par: number; yardage: number | null }[];
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
          .map((hole) => ({ number: hole.number, par: hole.par, yardage: hole.yardage })),
      })),
    })),
  };
}
