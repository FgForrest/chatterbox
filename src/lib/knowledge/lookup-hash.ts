import { createHmac } from "node:crypto";
import { env } from "@/lib/env";

function lookupSecret(): string {
    const secret = env.API_TOKEN_HASH_SECRET ?? env.BETTER_AUTH_SECRET;
    if (!secret) {
        throw new Error("Lookup hash secret is not configured");
    }
    return secret;
}

/**
 * Deterministic lookup key for a value that is stored encrypted.
 *
 * User-authored names and email addresses are encrypted at rest. Encryption
 * is not deterministic, which makes an encrypted column impossible to join,
 * search or uniquely constrain.
 *
 * So the value is stored twice: encrypted for display, and HMAC'd here for
 * lookup. Same reasoning and same secret as `rate-limit.ts` and the API
 * token hashes: a plain digest of an email address is trivially reversible
 * by dictionary, an HMAC keyed off a server secret is not.
 */
export function lookupHash(value: string): string {
    return createHmac("sha256", lookupSecret())
        .update(normalizeForLookup(value))
        .digest("hex");
}

/**
 * Fold away case and surrounding whitespace. Deliberately no further
 * normalisation.
 */
export function normalizeForLookup(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * `lookupHash` for one kind of value, so equal strings of different kinds
 * (a relation type's label and an entity's name, say) never share a key.
 * The domain is part of what is hashed, before the value.
 *
 * Also folds Unicode composition and runs of inner whitespace, which a
 * typed label or name varies in; emails keep `lookupHash`.
 */
export function domainLookupHash(domain: string, value: string): string {
    return createHmac("sha256", lookupSecret())
        .update(`${domain}\u0000${normalizeLabelForLookup(value)}`)
        .digest("hex");
}

/** `normalizeForLookup`, plus Unicode NFC and single inner spaces. */
export function normalizeLabelForLookup(value: string): string {
    return normalizeForLookup(value).normalize("NFC").replace(/\s+/g, " ");
}
