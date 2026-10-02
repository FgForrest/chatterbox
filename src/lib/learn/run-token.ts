/**
 * The token a Learn run's model calls Riffado's tools with (Task 3.5): an
 * HMAC over the run id and when it was issued, keyed by the server secret.
 * It names the run and nothing else; the user, recording and scopes are
 * derived from the run. It is valid for `LEARN_RUN_TOKEN_MAX_AGE_MS`
 * (generous: a run can queue behind the bridge), and the endpoint accepts
 * it only while the run is `running`. A correction pass's token is the
 * same, under its own version and key: one never passes for the other.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const LEARN_RUN_TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
interface TokenKind {
    version: string;
    domain: string;
}

const LEARN_RUN: TokenKind = {
    version: "lr1",
    domain: "riffado:learn-run-token",
};
const CORRECTION_PASS: TokenKind = {
    version: "cp1",
    domain: "riffado:correction-pass-token",
};

const derived = new Map<string, { secret: string; key: Buffer }>();

/**
 * A kind of token's own key, derived from the server secret (HKDF), so
 * nothing else keyed by that secret can produce or check one.
 */
function key(kind: TokenKind): Buffer {
    const secret = env.API_TOKEN_HASH_SECRET ?? env.BETTER_AUTH_SECRET;
    if (!secret) throw new Error("The server secret is not configured");
    const held = derived.get(kind.domain);
    if (held?.secret === secret) return held.key;
    const fresh = Buffer.from(hkdfSync("sha256", secret, "", kind.domain, 32));
    derived.set(kind.domain, { secret, key: fresh });
    return fresh;
}

function sign(kind: TokenKind, id: string, issuedAt: number): string {
    return createHmac("sha256", key(kind))
        .update(`${kind.domain}\n${id}\n${issuedAt}`)
        .digest("base64url");
}

function issue(kind: TokenKind, id: string, now: number): string {
    return [kind.version, id, String(now), sign(kind, id, now)].join(".");
}

function verify(kind: TokenKind, token: string, now: number): string | null {
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [version, id, issued, signature] = parts as [
        string,
        string,
        string,
        string,
    ];
    if (version !== kind.version || !id || !/^\d{1,16}$/.test(issued)) {
        return null;
    }
    const issuedAt = Number(issued);
    if (issuedAt > now || now - issuedAt > LEARN_RUN_TOKEN_MAX_AGE_MS) {
        return null;
    }
    const expected = Buffer.from(sign(kind, id, issuedAt));
    const given = Buffer.from(signature);
    if (given.length !== expected.length) return null;
    return timingSafeEqual(given, expected) ? id : null;
}

export function issueLearnRunToken(runId: string, now = Date.now()): string {
    return issue(LEARN_RUN, runId, now);
}

/** The run a token names, or null when it is not one this server issued now. */
export function verifyLearnRunToken(
    token: string,
    now = Date.now(),
): string | null {
    return verify(LEARN_RUN, token, now);
}

export function issueCorrectionPassToken(
    passId: string,
    now = Date.now(),
): string {
    return issue(CORRECTION_PASS, passId, now);
}

/** The correction pass a token names, or null as for a run's. */
export function verifyCorrectionPassToken(
    token: string,
    now = Date.now(),
): string | null {
    return verify(CORRECTION_PASS, token, now);
}
