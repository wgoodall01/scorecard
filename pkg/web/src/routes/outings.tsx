import { createFileRoute } from "@tanstack/react-router";
import { OutingsPage, RequireAuth } from "@/App";

export const Route = createFileRoute("/outings")({
  component: () => (
    <RequireAuth>
      <OutingsPage />
    </RequireAuth>
  ),
});
