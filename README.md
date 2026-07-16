# Scorecard

This is an app that accepts image uploads of golf scorecards, extracts the scores and who's playing, sticks the data in a database, and then calculates fun metrics/prizes/awards based on the latest scores.

## 1. Ingest agent

We'll start by designing an ingest agent that can handle an image upload. We'll have an API endpoint that accepts a POST request (10mb max) with an image file. We'll generate a scorecard UUIDv7, then upload to `/cards/$id/image` in the bucket.

Once uploaded, we'll push an event to a CF job queue with the scorecard ID. The job-queue entrypoint on the same worker will process the image and extract the scorecard data.

We'll use the CF AI gateway and the vision capabilities of a capable OSS model (like Kimi K2 or similar) to extract the following:

```typescript
interface Scorecard {
  // Use a version number.
  version: 1;

  // Name of the course, e.g. "Buck Hill Falls Golf Course"
  courseName: string | null;

  // Sometimes the date will be hand-written on the scorecard.
  date?: string;

  // HoleSet is a set of holes.
  // This could either be a full 18-hole round, or a 9-hole round, or two 9-hole courses played consecutively.
  // Omit any HoleSets for which no holes were played.
  sets: Array<HoleSet>;
}

interface HoleSet {
  // The name of the hole set, if available.
  // Think "Front", "Back", "Course A", "Red", etc.
  setName: string | null;

  // The holes in this set. This could be 9 or 18 holes.
  holes: Array<Hole>;

  // The players and their scores for this set of holes.
  scores: Array<PlayerScores>;
}

// Use the technical name of each tee. By convention, colors map:
// - TIPS is the farthest tee, usually blue or black.
// - BACK is the next farthest tee, usually blue or black.
// - STANDARD is the standard tee, usually white.
// - SENIOR is the senior tee, usually gold or yellow.
// - FORWARD is the forward tee, usually red.
// - JUNIOR is the junior tee, usually green. Less common.
type Tee = "TIPS" | "BACK" | "STANDARD" | "SENIOR" | "FORWARD" | "JUNIOR";

interface Hole {
  // The par for this hole. Null if not specified on the scorecard.
  par: number | { men: number; women: number };

  // The yardage for this hole from each tee.
  yardage: Record<Tee, number>;
}

interface PlayerScores {
  // Player name, nickname, or initials.
  name: string;

  // The tee this player played from. Null if not specified on the scorecard.
  tee?: Tee;

  // The player's scores recorded for each hole
  // MUST equal the length of `HoleSet.holes`. If a player didn't play a hole, fill with `null`.
  scores: Array<number | null>;
}
```

When done, we'll upload to `cards/$id/extracted.json` in the bucket, and ACK the job-queue entry.

### Evals

In pkg/api/eval/scorecard/$LABEL/{image.foo,extracted.json}, we'll have known-correct image/extract pairs. Write a `vitest` test that'll use the @cloudflare/vitest-pool-workers package and `wrangler dev --remote` to run requests through the API gateway. Each test should run in parallel, and results should deep-equal the right JSON exactly (obv. it's OK for e.g. key ordering to differ).
