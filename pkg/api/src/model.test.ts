// Verifies resolveModel can reach every model this project uses through the
// live `env.AI` binding — vision input + structured output at each spec's
// pinned effort, the exact shape the scorecard agent uses. These are real
// gateway calls (the AI binding is always remote): tiny prompts, a 1x1 image,
// fractions of a cent per run, but they do cost money and network time.
// Runs sequentially — workers-ai-provider's gateway delegate has a known race
// under high test concurrency (see CF_API_ISSUES.md issue 4).
import { env } from "cloudflare:test";
import { generateObject } from "ai";
import { describe, expect, it } from "vitest";
import type { Env } from "../env";
import { z } from "zod";
import {
  imageProviderOptionsFor,
  maxOutputTokensFor,
  type ModelSpec,
  providerOptionsFor,
  resolveModel,
} from "./model";

const bindings = env as unknown as Env["Bindings"];

const SPECS: ModelSpec[] = [
  "openai/gpt-5.4@low",
  "openai/gpt-5.4-mini@low",
  "openai/gpt-5.6-luna@low",
  "openai/gpt-5.6-terra@low",
  "anthropic/claude-sonnet-5@low",
  "anthropic/claude-fable-5@low",
  "google/gemini-3.5-flash@low",
  "google/gemini-3.1-pro-preview@low",
];

// 1x1 red pixel PNG
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ColorAnswer = z.object({
  color: z.string().describe("The dominant color of the image, one word."),
});

describe("resolveModel reaches every model we use via the AI binding", () => {
  it.each(SPECS)(
    "%s",
    async (spec) => {
      const { object } = await generateObject({
        model: resolveModel(bindings, spec),
        schema: ColorAnswer,
        maxOutputTokens: maxOutputTokensFor(spec, 2048),
        providerOptions: providerOptionsFor(spec),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is the dominant color of this image?" },
              {
                type: "image",
                image: TINY_PNG,
                mediaType: "image/png",
                providerOptions: imageProviderOptionsFor(spec),
              },
            ],
          },
        ],
      });
      expect(typeof object.color).toBe("string");
      expect(object.color.length).toBeGreaterThan(0);
    },
    120_000,
  );
});
