import { useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import { Camera, CameraOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

// Fail-open camera sniff: enumerateDevices reports device kinds without any
// permission prompt, so an empty videoinput list means there is definitely no
// camera. Anything ambiguous (blocked API, insecure context) reports true.
export function useLikelyHasCamera() {
  const [hasCamera, setHasCamera] = useState(true);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        if (!cancelled && !devices.some((device) => device.kind === "videoinput"))
          setHasCamera(false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return hasCamera;
}

/**
 * Live-camera photo capture. Prefers the rear (environment-facing) camera and
 * falls back to whatever camera exists (e.g. a laptop webcam). Renders as a
 * fullscreen surface with a shutter button on mobile and a centered modal on
 * sm and up. Captured frames arrive via `onCapture` as a JPEG File.
 */
export function CameraDialog({
  open,
  onOpenChange,
  onCapture,
  title = "Take a photo",
  description = "Line up your shot and hold steady.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: (image: File) => void;
  title?: string;
  description?: string;
}) {
  const webcamRef = useRef<Webcam>(null);
  const [ready, setReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReady(false);
      setCameraError(null);
    }
  }, [open]);

  function takePhoto() {
    const dataUrl = webcamRef.current?.getScreenshot();
    if (!dataUrl) return;
    const [, data] = dataUrl.split(",");
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    onOpenChange(false);
    onCapture(new File([bytes], "camera-photo.jpg", { type: "image/jpeg" }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Fullscreen camera surface on mobile; centered modal on sm and up. */}
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-black p-0 text-white sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:gap-6 sm:rounded-4xl sm:bg-popover sm:p-6 sm:text-popover-foreground"
      >
        <DialogHeader className="max-sm:flex-row max-sm:items-center max-sm:justify-between max-sm:px-4 max-sm:pt-[max(1rem,env(safe-area-inset-top))] max-sm:pb-3">
          <div className="flex flex-col gap-1.5">
            <DialogTitle className="max-sm:text-white">{title}</DialogTitle>
            <DialogDescription className="max-sm:hidden">{description}</DialogDescription>
          </div>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="bg-white/10 text-white hover:bg-white/20 hover:text-white sm:hidden"
              />
            }
          >
            <X />
            <span className="sr-only">Close camera</span>
          </DialogClose>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black sm:aspect-[4/3] sm:flex-none sm:rounded-2xl">
          {cameraError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <CameraOff aria-hidden="true" className="size-6 text-white/70" />
              <p className="max-w-sm text-sm text-white/80">{cameraError}</p>
            </div>
          ) : (
            open && (
              <>
                <Webcam
                  ref={webcamRef}
                  audio={false}
                  screenshotFormat="image/jpeg"
                  screenshotQuality={0.92}
                  forceScreenshotSourceSize
                  videoConstraints={{
                    facingMode: { ideal: "environment" },
                    width: { ideal: 2560 },
                    height: { ideal: 1440 },
                  }}
                  onUserMedia={() => setReady(true)}
                  onUserMediaError={(mediaError) =>
                    setCameraError(
                      mediaError instanceof DOMException && mediaError.name === "NotAllowedError"
                        ? "Camera access was denied. Allow it in your browser settings, or upload an image instead."
                        : "We couldn’t start your camera. Try uploading an image instead.",
                    )
                  }
                  className="h-full w-full object-contain"
                />
                {!ready && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
                    <Spinner />
                    Starting camera…
                  </div>
                )}
              </>
            )
          )}
        </div>
        <div className="flex items-center justify-center pt-4 pb-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] sm:hidden">
          <button
            type="button"
            onClick={takePhoto}
            disabled={!ready}
            aria-label="Take photo"
            className="group flex size-18 items-center justify-center rounded-full border-4 border-white/70 transition-opacity disabled:opacity-40"
          >
            <span className="size-14 rounded-full bg-primary transition-transform group-active:scale-90" />
          </button>
        </div>
        <DialogFooter className="max-sm:hidden">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={takePhoto} disabled={!ready}>
            <Camera data-icon="inline-start" />
            Capture photo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
