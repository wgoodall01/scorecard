import { APICallError, generateObject } from "ai";
import { RateLimitError, ScorecardReadError } from "../../extraction_errors";
import {
  imageProviderOptionsFor,
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
} from "../../model";
import { CardMetadata } from "./schema";

const METADATA_PROMPT = `You are extracting a golf course's printed LAYOUT from a photo of a scorecard. This is NOT about the handwritten scores — ignore any pencil marks. You are reading the pre-printed rating table: the nine names, the tee positions, and each tee's per-hole par and yardage.

A scorecard usually prints one, two, or three "nines" (named nine-hole loops). Each nine has its own name — often printed as a header or watermarked across the card (e.g. "White Oak", "Blue Spruce", "Red Maple"). Use that as the nine's name. Do NOT confuse a nine name with the course's own name, with hole names (some courses print a unique name above every hole column), or with section labels ("Initials", "Handicap", "Scorer").

Within each nine, the card prints a grid: one ROW per tee position (labeled at the left, e.g. "Blue", "White", "Gold", "Red", "Green", and sometimes combination tees like "Blue/White" or "Red/Green"), and one COLUMN per hole. Each cell is that tee's yardage for that hole. Capture EVERY tee row as a separate tee, with its exact printed name.

For each tee, list its holes in printed order. For each hole record: its printed hole number, its par, and its yardage from that tee. Par is printed in a "Par" row that is usually shared by all tees — repeat it onto every tee's holes. Occasionally a hole's par differs by tee, printed as a split like "4/5"; in that case give the longer (back) tees the higher par and the forward tees the lower par. Use null for a yardage that isn't printed or isn't legible; par should always be a single number.

Do not invent tees, holes, or nines that aren't printed. Only include the "9 Tot" / "18 Tot" columns' data as nothing — those are totals, not holes.

When a text value is unknown, use null — never an empty string. Respond with JSON matching the provided schema exactly.`;

// Modeled on card_scores: gemini-3.5-flash reads scorecard grids cheaply and
// accurately. Layout tables are larger than a single played round (many tees ×
// many holes), so the output-token ceiling is higher.
const DEFAULT_MODEL: ModelSpec = "google/gemini-3.5-flash@low";

export async function extractCardMetadata({
  image,
  resolver,
  model = DEFAULT_MODEL,
}: {
  image: { buf: ArrayBuffer; contentType: string };
  resolver: ModelResolver;
  model?: ModelSpec;
}) {
  try {
    const { object } = await generateObject({
      model: resolver(model),
      schema: CardMetadata,
      maxOutputTokens: maxOutputTokensFor(model, 16384),
      providerOptions: providerOptionsFor(model),
      system: METADATA_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the course layout from this scorecard image." },
            {
              type: "image",
              image: image.buf,
              mediaType: image.contentType,
              providerOptions: imageProviderOptionsFor(model),
            },
          ],
        },
      ],
    });

    if (object.error) throw new ScorecardReadError(object.error);
    return object;
  } catch (error) {
    if (error instanceof ScorecardReadError) throw error;
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Vision model rate limited");
    }
    throw error;
  }
}
