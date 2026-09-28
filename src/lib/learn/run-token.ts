/**
 * The token a Learn run's model calls Riffado's tools with (Task 3.5): an
 * HMAC over the run id and when it was issued, keyed by the server secret.
 * It names the run and nothing else; the user, recording and scopes are
 * derived from the run. It is valid for `LEARN_RUN_TOKEN_MAX_AGE_MS`
 * (generous: a run can queue behind the bridge), and the endpoint accepts
 * it only while the run is `running`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const LEARN_RUN_TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const VERSION = "lr1";
const DOMAIN = "riffado:learn-run-token";

function secret(): string {
    const value = env.API_TOKEN_HASH_SECRET ?? env.BETTER_AUTH_SECRET;
    if (!value) throw new Error("The server secret is not configured");
    return value;
}

function sign(runId: string, issuedAt: number): string {
    return createHmac("sha256", secret())
        .update(`${DOMAIN}\n${runId}\n${issuedAt}`)
        .digest("base64url");
}

export function issueLearnRunToken(runId: string, now = Date.now()): string {
    return [VERSION, runId, String(now), sign(runId, now)].join(".");
}

/** The run a token names, or null when it is not one this server issued now. */
export function verifyLearnRunToken(
    token: string,
    now = Date.now(),
): string | null {
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [version, runId, issued, signature] = parts as [
        string,
        string,
        string,
        string,
    ];
    if (version !== VERSION || !runId || !/^\d{1,16}$/.test(issued)) {
        return null;
    }
    const issuedAt = Number(issued);
    if (issuedAt > now || now - issuedAt > LEARN_RUN_TOKEN_MAX_AGE_MS) {
        return null;
    }
    const expected = Buffer.from(sign(runId, issuedAt));
    const given = Buffer.from(signature);
    if (given.length !== expected.length) return null;
    return timingSafeEqual(given, expected) ? runId : null;
}
