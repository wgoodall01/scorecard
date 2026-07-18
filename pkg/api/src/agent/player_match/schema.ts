import { z } from "zod";

// One entry per input name, in input order. userId null = "no confident
// match". Same provider structured-output constraints as the extraction
// schema: all fields required, null (never a missing key) for absence.
export const PlayerMatch = z.object({
  name: z.string().describe("The scorecard name, exactly as it was given to you."),
  userId: z
    .string()
    .nullable()
    .describe(
      "The id of the matched player from searchPlayers results, or null when no " +
        "player is a confident match.",
    ),
});
export type PlayerMatchSchema = z.infer<typeof PlayerMatch>;

export const PlayerMatchAnswer = z.object({
  matches: z
    .array(PlayerMatch)
    .describe("Exactly one entry per input name, in the same order as the input."),
});
export type PlayerMatchAnswerSchema = z.infer<typeof PlayerMatchAnswer>;
