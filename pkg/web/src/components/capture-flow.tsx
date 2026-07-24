import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Calculator,
  Camera,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  ImageUp,
  NotebookText,
  PenLine,
  RefreshCcw,
  ScanText,
  Send,
  type LucideIcon,
} from "lucide-react";
import type { ExtractDataSchema, MatchedData } from "api";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { CameraDialog, useLikelyHasCamera } from "@/components/camera-dialog";
import { ImageExpand } from "@/components/image-expand";
import { ReviewRound } from "@/components/review-round";
import { Stepper } from "@/components/stepper";
import { useAuth } from "@/lib/auth-context";
import { resizeImageForCapture } from "@/lib/image_resize";
import { isPending, scorecardScoresQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

type FlowStep = "capture" | "analyze" | "review" | "submit";

// The fake-but-honest progress bar. A hyperbolic curve p(t) = t / (t + K):
// it always increases and always decelerates, asymptotically approaching (but
// never reaching) 100% — so it never plateaus at a fixed value the way an
// exponential-to-95% curve does, and only the real result snaps it to 100.
// K sets the pace (p = 50% at t = K); tuned deliberately slow so it reads as
// "still working." PROGRESS_MIN_STEP is a tiny per-tick floor so that even in
// the far decelerated tail the bar keeps visibly creeping and never looks
// frozen. Capped just below 1 until completion.
const PROGRESS_K_MS = 6500;
const PROGRESS_CAP = 0.994;
const PROGRESS_MIN_STEP = 0.0009;
const PROGRESS_TICK_MS = 120;

type CaptureResult = {
  extracted: ExtractDataSchema;
  matched: MatchedData | null;
};

// The extraction gets this long before the wait is called a failure.
const EXTRACT_TIMEOUT_MS = 60_000;

export function CaptureFlow() {
  const { token } = useAuth();
  const hasCamera = useLikelyHasCamera();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const analyzeStartedAt = useRef<number | null>(null);
  const [outingId, setOutingId] = useState<string | null>(null);
  // When the extraction wait runs out (set per upload, read by the poll).
  const deadlineRef = useRef(0);

  // The upload is multipart, which the route parses itself — so there's no
  // typed RPC method for it and the mutation writes the fetch by hand.
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      // Preview (and crop review thumbnails) from the EXACT resized bytes the
      // model sees, not the original file — so the extraction's bounding boxes
      // line up with what we crop, regardless of the phone's EXIF orientation
      // or original resolution.
      const resized = await resizeImageForCapture(file);
      const form = new FormData();
      form.set("image", resized);
      form.set("extract", JSON.stringify({ scores: true }));
      const response = await fetch("/api/scorecard", {
        method: "POST",
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!response.ok || !body.id)
        throw new Error(body.error ?? "Unable to upload your scorecard.");
      return { id: body.id, resizedUrl: URL.createObjectURL(resized) };
    },
    onSuccess: ({ resizedUrl }) => setPreviewUrl(resizedUrl),
  });
  const captureId = uploadMutation.data?.id ?? null;

  // Then wait out the extraction job, polling until it lands.
  const scoresQuery = useQuery(scorecardScoresQuery(captureId, deadlineRef.current));
  // A pending body means "ask again"; anything else IS the extraction.
  const pending = isPending(scoresQuery.data);
  const result: CaptureResult | null =
    scoresQuery.data !== undefined && !isPending(scoresQuery.data) ? scoresQuery.data : null;
  const timedOut = pending && Date.now() >= deadlineRef.current;

  const error =
    uploadMutation.error?.message ??
    scoresQuery.error?.message ??
    (timedOut ? "Extraction is taking longer than expected. Please try again." : null);

  // The step follows the data: an image in flight means Analyze, a finished
  // extraction means Review, a submitted outing means Submit.
  const step: FlowStep = outingId ? "submit" : result ? "review" : image ? "analyze" : "capture";

  const analyzeStatus = uploadMutation.isPending
    ? "Uploading your photo…"
    : // Surface the job's own progress message ("Reading the scorecard…",
      // "Matching golfers and course…") when it has reported one.
      ((isPending(scoresQuery.data) ? scoresQuery.data.message : null) ??
      "Reading the round details…");

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  // Drive the progress curve while analysis is in flight. It approaches
  // PROGRESS_TARGET asymptotically off the elapsed time, so it never stalls
  // and never claims "done" before the result actually arrives.
  useEffect(() => {
    if (step !== "analyze" || error) return;
    const tick = () => {
      const startedAt = analyzeStartedAt.current ?? Date.now();
      const elapsed = Date.now() - startedAt;
      const curve = elapsed / (elapsed + PROGRESS_K_MS);
      // Take whichever is further along — the curve, or a small guaranteed
      // step past where we already are — so it always visibly advances even
      // once the curve has flattened out, but never jumps backward.
      setProgress((prev) => Math.min(PROGRESS_CAP, Math.max(curve, prev + PROGRESS_MIN_STEP)));
    };
    tick();
    const id = window.setInterval(tick, PROGRESS_TICK_MS);
    return () => window.clearInterval(id);
  }, [step, error]);

  function reset() {
    setImage(null);
    setPreviewUrl(null);
    setOutingId(null);
    setProgress(0);
    uploadMutation.reset();
  }

  function startAnalyze(nextImage: File) {
    setImage(nextImage);
    setPreviewUrl(URL.createObjectURL(nextImage));
    setProgress(0);
    analyzeStartedAt.current = Date.now();
    deadlineRef.current = Date.now() + EXTRACT_TIMEOUT_MS;
    uploadMutation.mutate(nextImage);
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Sticky progress bar: pt swallows the iOS safe area when stuck, and
          blends into the page background when at rest. */}
      <div className="sticky top-0 z-10 -mx-5 border-b bg-background/95 px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-4 backdrop-blur md:-mx-10 md:px-10">
        <Stepper
          aria-label="Capture progress"
          className="max-w-md"
          current={step}
          busy={step === "analyze" && !error}
          steps={[
            { key: "capture", label: "Capture", icon: Camera },
            { key: "analyze", label: "Analyze", icon: ScanText },
            { key: "review", label: "Review", icon: ClipboardCheck },
            { key: "submit", label: "Submit", icon: Send },
          ]}
        />
      </div>

      {step === "capture" && (
        <>
          <Empty className="min-h-64 border bg-muted/30">
            <EmptyHeader>
              <EmptyMedia variant="icon" className="rounded-full bg-primary/10 text-primary">
                <Camera />
              </EmptyMedia>
              <EmptyTitle>Capture a scorecard</EmptyTitle>
              <EmptyDescription>
                Take a photo of your scorecard or upload one from your library. We’ll read the round
                details for you.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <div className="flex w-full max-w-60 flex-col gap-3">
                {hasCamera && (
                  <Button onClick={() => setCameraOpen(true)}>
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
                      if (selected) startAnalyze(selected);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            </EmptyContent>
          </Empty>
          <ul className="flex flex-col gap-4">
            <CaptureTip icon={Calculator} title="Add up your scores">
              Add up your scores and write your totals on the card before submitting. This helps us
              check that we’ve read the numbers right.
            </CaptureTip>
            <CaptureTip icon={PenLine} title="Write names clearly">
              Write each player’s name clearly somewhere on the card. This helps us match your
              scores against known golfers in your party.
            </CaptureTip>
          </ul>
        </>
      )}

      {step === "analyze" && (
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
            <EmptyTitle>{error ? "Analysis failed" : "Analyzing your scorecard"}</EmptyTitle>
            <EmptyDescription>{error ?? analyzeStatus}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {error ? (
              <div className="flex flex-wrap justify-center gap-3">
                <Button onClick={() => image && startAnalyze(image)}>
                  <RefreshCcw data-icon="inline-start" />
                  Try again
                </Button>
                <Button variant="outline" onClick={reset}>
                  Start over
                </Button>
              </div>
            ) : (
              <div className="flex w-full max-w-xs flex-col items-center gap-4">
                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                  aria-label="Analysis progress"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                {previewUrl && (
                  <ImageExpand
                    src={previewUrl}
                    alt="Scorecard being analyzed"
                    className="max-h-40 rounded-xl border object-contain opacity-80"
                  />
                )}
              </div>
            )}
          </EmptyContent>
        </Empty>
      )}

      {step === "review" && result && (
        <ReviewRound
          extracted={result.extracted}
          matched={result.matched}
          scorecardId={captureId}
          previewUrl={previewUrl}
          onRetake={reset}
          onSubmitted={setOutingId}
        />
      )}

      {step === "submit" && (
        <Empty className="min-h-64 border bg-muted/30">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-full bg-primary/10 text-primary">
              <CircleCheck />
            </EmptyMedia>
            <EmptyTitle>Scorecard submitted</EmptyTitle>
            <EmptyDescription>The round is saved and the scores are on the books.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <div className="flex flex-wrap justify-center gap-3">
              {outingId && (
                <Link className={buttonVariants()} to="/outings/$id" params={{ id: outingId }}>
                  <NotebookText data-icon="inline-start" />
                  View outing
                </Link>
              )}
              <Button variant="outline" onClick={reset}>
                <Camera data-icon="inline-start" />
                Capture another
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      )}

      <CameraDialog
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={startAnalyze}
        description="Line the scorecard up in the frame and hold steady."
      />
    </div>
  );
}

// One row of advice under the capture card: icon chip, bolded gist, detail.
function CaptureTip({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}
