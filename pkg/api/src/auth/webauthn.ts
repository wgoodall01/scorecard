import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { Jwt } from "hono/utils/jwt";
import { z } from "zod";
import type { Env } from "../../env";

export {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
};
export type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
};

type Bindings = Env["Bindings"];

// How long a user has to complete a ceremony (options → verify).
const CHALLENGE_TTL_SECONDS = 5 * 60;

// The Relying Party id + expected origin for a request, derived from its
// Origin header validated against the WEBAUTHN_ALLOWED_ORIGINS allowlist.
// Returns null when the origin is absent or not allowed (caller replies 400).
// Per-request derivation means localhost / prod / ngrok all work with no
// per-environment build; the resolved pair is bound into the challenge token so
// verify uses the same values.
export function resolveRp(env: Bindings, originHeader: string | undefined | null) {
  if (!originHeader) return null;
  const allowed = env.WEBAUTHN_ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowed.includes(originHeader)) return null;
  try {
    return { rpID: new URL(originHeader).hostname, origin: originHeader };
  } catch {
    return null;
  }
}

// The stateless challenge token: a short-lived JWT carrying the server-issued
// challenge and the ceremony's bound context (rpID/origin, and for
// registration the target user + invite). The verify step confirms the
// returned challenge equals this one (WebAuthn spec §7.1/§7.2) with no
// server-side storage. Signed with AUTHN_CHALLENGE_SIGNING_SECRET — a
// dedicated secret so session and challenge tokens can't be cross-forged.
export const ChallengePayload = z.object({
  challenge: z.string(),
  rpID: z.string(),
  origin: z.string(),
  userId: z.string().optional(),
  inviteToken: z.string().optional(),
});
export type ChallengePayloadSchema = z.infer<typeof ChallengePayload>;

export async function signChallenge(secret: string, payload: ChallengePayloadSchema) {
  const now = Math.floor(Date.now() / 1000);
  return Jwt.sign({ ...payload, iat: now, exp: now + CHALLENGE_TTL_SECONDS }, secret, "HS256");
}

export async function verifyChallenge(
  secret: string,
  token: string,
): Promise<ChallengePayloadSchema | null> {
  try {
    const payload = await Jwt.verify(token, secret, "HS256");
    // Jwt.verify only enforces exp when present; every challenge token we mint
    // has one, so a token without exp is not ours.
    if (typeof payload.exp !== "number") return null;
    const result = ChallengePayload.safeParse(payload);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// COSE public-key round-trip: stored as base64url text (not a blob), decoded
// back to bytes for verifyAuthenticationResponse.
export function encodePublicKey(publicKey: Uint8Array<ArrayBuffer>) {
  return isoBase64URL.fromBuffer(publicKey);
}
export function decodePublicKey(publicKey: string) {
  return isoBase64URL.toBuffer(publicKey);
}

// A long, random invite/recovery token (32 bytes, base64url).
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>;
  return isoBase64URL.fromBuffer(bytes);
}
