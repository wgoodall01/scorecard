import { createFileRoute, redirect } from "@tanstack/react-router";

// The app has no home page yet; capture is the de-facto landing tab.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/capture", replace: true });
  },
});
