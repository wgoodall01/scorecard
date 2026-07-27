import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CourseLayout, type CourseLayoutSchema } from "../layout";
import { UsgaFacilityData, type UsgaFacilityDataSchema } from "../schema";

// A research_course fixture is a directory under eval/fixtures/<label>/ holding
// the two inputs (layouts.json + usga.json, both required to run) and an
// optional reviewed proposal.json label to grade against.
//
// layouts.json is an ARRAY of CourseLayouts, mirroring what the job passes: the
// bhf-* fixtures cover all three real combinations — the GolfCourseAPI feed
// alone (the normal path), a scorecard photo alone (the fallback when the feed
// has nothing), and both together (the gap-filling path, where the card's job is
// to supply the printed nine names the feed lacks).
export type ResearchFixture = {
  label: string;
  layouts: CourseLayoutSchema[];
  usga: UsgaFacilityDataSchema;
  // Parsed proposal.json when the fixture is labeled; null otherwise.
  expected: unknown | null;
};

export function loadFixtures(fixturesDir: string): ResearchFixture[] {
  let labels: string[];
  try {
    labels = readdirSync(fixturesDir).filter((name) =>
      statSync(join(fixturesDir, name)).isDirectory(),
    );
  } catch {
    return [];
  }

  const fixtures: ResearchFixture[] = [];
  for (const label of labels.sort()) {
    const dir = join(fixturesDir, label);
    const layoutsPath = join(dir, "layouts.json");
    const usgaPath = join(dir, "usga.json");
    if (!existsSync(layoutsPath) || !existsSync(usgaPath)) {
      console.warn(`Skipping fixture "${label}": missing layouts.json or usga.json`);
      continue;
    }
    const layouts = CourseLayout.array()
      .min(1)
      .parse(JSON.parse(readFileSync(layoutsPath, "utf-8")));
    const usga = UsgaFacilityData.parse(JSON.parse(readFileSync(usgaPath, "utf-8")));

    let expected: unknown | null = null;
    try {
      expected = JSON.parse(readFileSync(join(dir, "proposal.json"), "utf-8"));
    } catch {
      // unlabeled fixture — still runnable, just not comparable
    }
    fixtures.push({ label, layouts, usga, expected });
  }
  return fixtures;
}
