import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { evalModel } from "../src/model_provider";
import { extractScorecard } from "../src/scorecard_parse_agent";
import { evalModelSpecs, loadFixtures } from "./fixtures";

const fixtures = await loadFixtures(fileURLToPath(new URL("./scorecard", import.meta.url)));
const models = evalModelSpecs();

// Every extraction (or its error) is snapshotted to
// eval/results/<run-timestamp>/<model@effort>--<fixture>.json so model
// outputs can be inspected after the run, not just pass/fail-graded.
const resultsDir = fileURLToPath(
  new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}`, import.meta.url),
);
function snapshot(name: string, data: unknown) {
  mkdirSync(resultsDir, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9._@-]+/g, "_");
  writeFileSync(join(resultsDir, `${safeName}.json`), JSON.stringify(data, null, 2));
}

if (fixtures.length === 0) {
  it("has no eval fixtures yet", () => {
    console.warn(
      "No eval fixtures found — add pkg/api/eval/scorecard/<label>/{image.*,extracted.json} " +
        "pairs to enable prompt-iteration evals.",
    );
  });
} else {
  console.log(`eval snapshots → ${resultsDir}`);
  const cases = models.flatMap((spec) =>
    fixtures.map((fixture) => ({
      spec,
      modelLabel: spec.effort ? `${spec.model}@${spec.effort}` : spec.model,
      label: fixture.label,
      contentType: fixture.contentType,
      bytes: fixture.bytes,
      expected: fixture.expected,
    })),
  );

  describe("scorecard extraction eval", () => {
    it.concurrent.each(cases)(
      "$modelLabel/$label",
      async ({ spec, modelLabel, label, contentType, bytes, expected }) => {
        const snapshotName = `${modelLabel}--${label}`;
        let result: Awaited<ReturnType<typeof extractScorecard>>;
        try {
          result = await extractScorecard(evalModel, bytes, contentType, spec);
        } catch (error) {
          snapshot(snapshotName, { error: String(error) });
          throw error;
        }
        snapshot(snapshotName, result);
        expect(result).toEqual(expected);
      },
    );
  });
}
