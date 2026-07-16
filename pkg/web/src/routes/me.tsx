import { createFileRoute } from "@tanstack/react-router";
import { MePage, RequireAuth } from "@/App";

export const Route = createFileRoute("/me")({
  component: () => (
    <RequireAuth>
      <MePage />
    </RequireAuth>
  ),
});
