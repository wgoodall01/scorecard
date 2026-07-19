import {
  APICallError,
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type ToolSet,
  type UserContent,
} from "ai";
import type { z } from "zod";
import { RateLimitError } from "../extraction_errors";
import {
  maxOutputTokensFor,
  type ModelResolver,
  type ModelSpec,
  providerOptionsFor,
} from "../model";

const DEFAULT_MAX_STEPS = 16;

// Runs a small agentic tool loop that must finish by calling the terminal
// `answer` tool (which has no execute, so calling it ends generation). This is
// the shape shared by the matching agents: search the database with the
// provided tools as many times as needed, then submit a structured answer.
//
// The answer schema lives in a tool inputSchema, so the same provider
// structured-output constraints as card_scores/schema.ts apply: index-aligned
// arrays, every field required, null (never absent keys) for "no value".
export async function runAnswerAgent<TSchema extends z.ZodType>({
  resolver,
  model,
  system,
  prompt,
  tools,
  answerSchema,
  answerDescription,
  maxSteps = DEFAULT_MAX_STEPS,
}: {
  resolver: ModelResolver;
  model: ModelSpec;
  system: string;
  // Text, or multimodal content parts (e.g. text plus cropped handwriting
  // images) — carried into the forced-answer fallback unchanged.
  prompt: string | UserContent;
  tools: ToolSet;
  answerSchema: TSchema;
  answerDescription: string;
  maxSteps?: number;
}): Promise<z.output<TSchema>> {
  const allTools = {
    ...tools,
    answer: tool({ description: answerDescription, inputSchema: answerSchema }),
  };

  const userMessage = { role: "user" as const, content: prompt };

  try {
    const result = await generateText({
      model: resolver(model),
      system,
      messages: [userMessage],
      tools: allTools,
      toolChoice: "required",
      stopWhen: [stepCountIs(maxSteps), hasToolCall("answer")],
      maxOutputTokens: maxOutputTokensFor(model, 4096),
      providerOptions: providerOptionsFor(model),
    });

    let answerCall = result.steps
      .flatMap((step) => step.toolCalls)
      .findLast((call) => call.toolName === "answer");

    // Some models keep searching until the step cap without ever submitting.
    // Force one final generation where the ONLY legal move is the answer
    // tool, carrying the whole search transcript forward.
    if (!answerCall) {
      const forced = await generateText({
        model: resolver(model),
        system,
        messages: [userMessage, ...result.response.messages],
        tools: allTools,
        toolChoice: { type: "tool", toolName: "answer" },
        maxOutputTokens: maxOutputTokensFor(model, 4096),
        providerOptions: providerOptionsFor(model),
      });
      answerCall = forced.toolCalls.findLast((call) => call.toolName === "answer");
    }

    if (!answerCall) {
      throw new Error(`Agent finished without calling answer within ${maxSteps} steps`);
    }
    return answerSchema.parse(answerCall.input);
  } catch (error) {
    if (APICallError.isInstance(error) && error.statusCode === 429) {
      throw new RateLimitError("Matching model rate limited");
    }
    throw error;
  }
}
