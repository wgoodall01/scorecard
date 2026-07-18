import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
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
import { ReviewRound } from "@/components/review-round";
import { Stepper } from "@/components/stepper";
import { useAuth } from "@/lib/auth-context";
import { resizeImageForCapture } from "@/lib/image_resize";
import { cn } from "@/lib/utils";

type FlowStep = "capture" | "analyze" | "review" | "submit";

type CaptureResult = {
  extracted: ExtractDataSchema;
  matched: MatchedData | null;
};

export function CaptureFlow() {
  const { token } = useAuth();
  const hasCamera = useLikelyHasCamera();
  const [step, setStep] = useState<FlowStep>("capture");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [analyzeStatus, setAnalyzeStatus] = useState("");
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [outingId, setOutingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  function reset() {
    setStep("capture");
    setImage(null);
    setPreviewUrl(null);
    setResult(null);
    setCaptureId(null);
    setOutingId(null);
    setError(null);
  }

  function startAnalyze(nextImage: File) {
    setImage(nextImage);
    setPreviewUrl(URL.createObjectURL(nextImage));
    void analyze(nextImage);
  }

  async function analyze(imageToAnalyze: File) {
    if (!token) return;

    setStep("analyze");
    setError(null);
    setResult(null);

    try {
      setAnalyzeStatus("Uploading your photo…");
      const form = new FormData();
      form.set("image", await resizeImageForCapture(imageToAnalyze));
      const submitResponse = await fetch("/api/capture/submit", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const submitBody = (await submitResponse.json()) as { id?: string; error?: string };
      if (!submitResponse.ok || !submitBody.id)
        throw new Error(submitBody.error ?? "Unable to upload your scorecard.");
      setCaptureId(submitBody.id);

      setAnalyzeStatus("Reading the round details…");
      for (let attempt = 0; attempt < 60; attempt++) {
        const resultResponse = await fetch(
          `/api/capture/result?id=${encodeURIComponent(submitBody.id)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (resultResponse.status === 202) {
          await new Promise((resolve) => window.setTimeout(resolve, 750));
          continue;
        }

        const resultBody = (await resultResponse.json()) as unknown;
        if (!resultResponse.ok) {
          const message =
            typeof resultBody === "object" && resultBody && "error" in resultBody
              ? String(resultBody.error)
              : "Unable to extract your scorecard.";
          throw new Error(message);
        }
        setResult(resultBody as CaptureResult);
        setStep("review");
        return;
      }

      throw new Error("Extraction is taking longer than expected. Please try again.");
    } catch (analyzeError) {
      setError(
        analyzeError instanceof Error ? analyzeError.message : "Unable to analyze your scorecard.",
      );
    }
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
                <Button onClick={() => image && void analyze(image)}>
                  <RefreshCcw data-icon="inline-start" />
                  Try again
                </Button>
                <Button variant="outline" onClick={reset}>
                  Start over
                </Button>
              </div>
            ) : (
              previewUrl && (
                <img
                  src={previewUrl}
                  alt="Scorecard being analyzed"
                  className="max-h-40 rounded-xl border object-contain opacity-80"
                />
              )
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
          onSubmitted={(submittedOutingId) => {
            setOutingId(submittedOutingId);
            setStep("submit");
          }}
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
