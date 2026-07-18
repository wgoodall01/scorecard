import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// Preload route code on link hover/touchstart and restore scroll positions
// on back/forward — both recommended router defaults.
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
