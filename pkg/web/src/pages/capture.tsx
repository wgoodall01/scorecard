import { AppShell, PageHeading, PageTitle } from "@/App";
import { CaptureFlow } from "@/components/capture-flow";

export function CapturePage() {
  return (
    <AppShell>
      <PageTitle>Capture · Scorecard</PageTitle>
      <PageHeading title="Capture" description="Upload a scorecard to start a new round." />
      <CaptureFlow />
    </AppShell>
  );
}
