import type { Tee } from "api";

// Local mirror of the API's TEES list. Only the TYPE is imported from the api
// package — importing the value would pull the whole Worker module graph into
// the web bundle — and `satisfies` keeps the two lists in lockstep.
export const TEES = [
  "tips",
  "back",
  "standard",
  "senior",
  "front",
  "junior",
] as const satisfies readonly Tee[];

export const TEE_LABELS: Record<Tee, string> = {
  tips: "Tips",
  back: "Back",
  standard: "Standard",
  senior: "Senior",
  front: "Front",
  junior: "Junior",
};
