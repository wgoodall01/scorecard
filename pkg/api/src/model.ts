import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONValue, LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { anthropic as anthropicPlugin } from "workers-ai-provider/anthropic";
import { createGatewayProvider } from "workers-ai-provider/gateway";
import { google as googlePlugin } from "workers-ai-provider/google";
import { openai as openaiPlugin } from "workers-ai-provider/openai";
import type { Env } from "../env";

// A model reference is a single string: `provider/model@effort`. Effort is
// practically part of the model identity — the same model at two efforts
// behaves like two different models in cost and accuracy — so it travels
// inside the spec everywhere a model is named (agent default, eval flags).
// Effort levels are provider-defined (e.g. openai also has "minimal" and
// "xhigh"), so they're deliberately untyped here — the provider rejects
// levels it doesn't support.
export type ModelSpec = `${string}/${string}@${string}`;

const MODEL_SPEC_PATTERN = /^.+\/.+@.+$/;

// Model+effort combinations VERIFIED to be rejected upstream. This check is
// fail-open: an absent entry means "assumed fine" — only add a rule here once
// a combination has actually been observed to fail, with the reason.
const KNOWN_INVALID_EFFORTS: Array<{ model: RegExp; efforts: string[]; reason: string }> = [];

// Parses (and validates) a model spec into its parts. Throws on a malformed
// string or a combination known not to exist for that model.
export function parseModelSpec(spec: string): { model: string; effort: string } {
  if (!MODEL_SPEC_PATTERN.test(spec)) {
    throw new Error(
      `Invalid model spec "${spec}" — expected "provider/model@effort", ` +
        `e.g. "google/gemini-3.5-flash@low".`,
    );
  }
  const at = spec.lastIndexOf("@");
  const model = spec.slice(0, at);
  const effort = spec.slice(at + 1);
  for (const rule of KNOWN_INVALID_EFFORTS) {
    if (rule.model.test(model) && rule.efforts.includes(effort)) {
      throw new Error(`Invalid model spec "${spec}": ${rule.reason}`);
    }
  }
  return { model, effort };
}

// How an agent turns a spec into a callable model: production injects
// `(spec) => resolveModel(env, spec)` (Workers binding); the eval injects
// `evalModel` (gateway REST + token).
export type ModelResolver = (spec: ModelSpec) => LanguageModel;

const THINKING_MIN_OUTPUT_TOKENS = 10_000;

// OpenAI's reasoning, Anthropic's adaptive thinking, and Gemini's thinking
// all count against the same output-token budget as the answer itself, so
// give those models much more headroom than the caller's default (a low cap
// surfaces as an empty/truncated response, not a cheaper call).
const THINKING_OUTPUT_PATTERN = /^(openai|anthropic|google)\//;

export function maxOutputTokensFor(spec: ModelSpec, defaultTokens: number): number {
  return THINKING_OUTPUT_PATTERN.test(spec)
    ? Math.max(defaultTokens, THINKING_MIN_OUTPUT_TOKENS)
    : defaultTokens;
}

// Image content-part `providerOptions` per model. OpenAI models downscale
// image input by default — `detail: "original"` keeps the full-resolution
// capture. Only attached for openai/*: Google's path rejects requests whose
// image parts carry foreign-namespace providerOptions (7003 User Input
// Error), so this can't be applied unconditionally.
export function imageProviderOptionsFor(
  spec: ModelSpec,
): Record<string, Record<string, JSONValue>> | undefined {
  return spec.startsWith("openai/") ? { openai: { imageDetail: "original" } } : undefined;
}

// The spec's effort as generateObject `providerOptions`, translated into each
// provider's dialect (they all accept "low" | "medium" | "high"). Unknown
// providers get none — the effort in their spec is not honored.
export function providerOptionsFor(
  spec: ModelSpec,
): Record<string, Record<string, JSONValue>> | undefined {
  const { effort } = parseModelSpec(spec);
  if (spec.startsWith("anthropic/")) return { anthropic: { effort } };
  if (spec.startsWith("openai/")) return { openai: { reasoningEffort: effort } };
  if (spec.startsWith("google/")) return { google: { thinkingConfig: { thinkingLevel: effort } } };
  return undefined;
}

// Every model resolves through Cloudflare AI Gateway, always naming the
// `scorecard` gateway so provider auth resolves to its stored BYOK keys
// (openai, anthropic, google). No provider API key ever lives in this repo.
//
// Two entry points, same provider routing:
//   - resolveModel: production — through the `env.AI` binding (the binding
//     authenticates the Worker to the gateway; shows as `keySource: "BYOK"`
//     in the gateway logs).
//   - evalModel: local eval — through the gateway's public REST endpoints,
//     authenticated with an AI Gateway token (`cf-aig-authorization`) from
//     `.env.local`, so the eval runs in plain Node with no wrangler/workerd.

export function resolveModel(env: Env["Bindings"], spec: ModelSpec): LanguageModel {
  const { model } = parseModelSpec(spec);
  const gateway = { id: env.AI_GATEWAY_ID };

  // openai/* — Responses API. gpt-5.6 (Sol/Terra/Luna) requires the
  // Responses API outright, and gpt-5.4+ only accept image input as Responses
  // `input_image` blocks (chat/completions `image_url` is rejected with
  // "image_url is only supported by certain models"). The delegate's openai
  // plugin speaks Chat Completions, so these route through the gateway's
  // universal endpoint (`env.AI.gateway().run()`), which forwards the
  // Responses-shaped body verbatim and resolves the stored key.
  if (model.startsWith("openai/")) {
    const openai = createGatewayProvider(createOpenAI, { binding: env.AI, gateway });
    return openai.responses(model.slice("openai/".length));
  }

  const workersai = createWorkersAI({
    binding: env.AI,
    gateway,
    providers: [openaiPlugin, anthropicPlugin, googlePlugin],
  });

  // anthropic/* and google/* — provider-native wire format via the delegate,
  // forcing the gateway transport (`env.AI.gateway().run()`): the path with
  // guaranteed stored-key semantics, never Unified Billing's markup. It also
  // forwards provider-native model ids verbatim — Google's
  // `gemini-3.1-pro-preview` doesn't exist in the `/run` catalog's aliasing.
  // Costs resumable streaming, which generateObject doesn't use anyway.
  if (model.startsWith("anthropic/") || model.startsWith("google/")) {
    return workersai(model, { transport: "gateway" });
  }

  // Anything else passes straight through to the delegate's default path.
  return workersai(model);
}

function requireEnv(name: string): string {
  // Typed structurally so this compiles under any tsconfig that checks it
  // (pkg/web's tsc reaches this file through the AppType import chain).
  const process = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const value = process?.env?.[name];
  if (!value) {
    throw new Error(
      `evalModel requires ${name} in the environment — the eval vitest config loads it ` +
        `from the repo-root .env.local (AI_GATEWAY_TOKEN) and wrangler.toml ` +
        `(CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID).`,
    );
  }
  return value;
}

// The @ai-sdk providers unconditionally send their own auth header with the
// placeholder key. The gateway forwards any provider auth header it receives
// verbatim (that's how caller-supplied keys work), so the placeholder must be
// STRIPPED for the gateway to fall back to its stored BYOK key — the same
// strip the Workers binding's gateway delegate does.
const PROVIDER_AUTH_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"];

function strippedAuthFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    for (const header of PROVIDER_AUTH_HEADERS) request.headers.delete(header);
    return fetch(request);
  };
}

// Local-eval counterpart of resolveModel: same models, same gateway, but over
// the gateway's provider-native REST endpoints
// (gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…) with a
// `cf-aig-authorization` token instead of the Workers binding. The gateway
// still supplies the upstream credential (stored BYOK keys); the token only
// authenticates the caller to the gateway.
export function evalModel(spec: ModelSpec): LanguageModel {
  const { model } = parseModelSpec(spec);
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const gatewayId = requireEnv("AI_GATEWAY_ID");
  const token = requireEnv("AI_GATEWAY_TOKEN");
  const gatewayUrl = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`;
  const headers = { "cf-aig-authorization": `Bearer ${token}` };
  const providerFetch = strippedAuthFetch();

  if (model.startsWith("openai/")) {
    const openai = createOpenAI({
      baseURL: `${gatewayUrl}/openai`,
      apiKey: "unused",
      headers,
      fetch: providerFetch,
    });
    return openai.responses(model.slice("openai/".length));
  }
  if (model.startsWith("anthropic/")) {
    const anthropic = createAnthropic({
      baseURL: `${gatewayUrl}/anthropic/v1`,
      apiKey: "unused",
      headers,
      fetch: providerFetch,
    });
    return anthropic(model.slice("anthropic/".length));
  }
  if (model.startsWith("google/")) {
    const google = createGoogleGenerativeAI({
      baseURL: `${gatewayUrl}/google-ai-studio/v1beta`,
      apiKey: "unused",
      headers,
      fetch: providerFetch,
    });
    return google(model.slice("google/".length));
  }
  throw new Error(
    `evalModel can't reach "${model}": no gateway REST route for its provider — ` +
      `use resolveModel through the env.AI binding instead.`,
  );
}
