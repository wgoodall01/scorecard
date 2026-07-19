import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CardMetadata, type CardMetadataSchema } from "../../card_metadata/schema";
import { UsgaFacilityData, type UsgaFacilityDataSchema } from "../schema";

// A research_course fixture is a directory under eval/fixtures/<label>/ holding
// the two inputs (metadata.json + usga.json, both required to run) and an
// optional reviewed proposal.json label to grade against.
export type ResearchFixture = {
  label: string;
  metadata: CardMetadataSchema;
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
    const metadataPath = join(dir, "metadata.json");
    const usgaPath = join(dir, "usga.json");
    if (!existsSync(metadataPath) || !existsSync(usgaPath)) {
      console.warn(`Skipping fixture "${label}": missing metadata.json or usga.json`);
      continue;
    }
    const metadata = CardMetadata.parse(JSON.parse(readFileSync(metadataPath, "utf-8")));
    const usga = UsgaFacilityData.parse(JSON.parse(readFileSync(usgaPath, "utf-8")));

    let expected: unknown | null = null;
    try {
      expected = JSON.parse(readFileSync(join(dir, "proposal.json"), "utf-8"));
    } catch {
      // unlabeled fixture — still runnable, just not comparable
    }
    fixtures.push({ label, metadata, usga, expected });
  }
  return fixtures;
}
