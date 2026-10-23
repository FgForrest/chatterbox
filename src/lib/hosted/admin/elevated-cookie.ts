import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const ADMIN_ELEVATED_COOKIE = "riffado_admin_elev";

interface ElevatedPayload {
    userId: string;
    sessionId: string;
    issuedAt: number;
}

function secret(): string {
    const s = env.BETTER_AUTH_SECRET;
    if (!s)
        throw new Error(
            "BETTER_AUTH_SECRET missing -- cannot sign admin cookie",
        );
    return s;
}

function macFor(userId: string, sessionId: string, issuedAt: number): string {
    return createHmac("sha256", secret())
        .update(`${userId}.${sessionId}.${issuedAt}`)
        .digest("hex");
}

export function signElevatedCookie(
    userId: string,
    sessionId: string,
    now = Date.now(),
): string {
    const mac = macFor(userId, sessionId, now);
    return `${userId}.${sessionId}.${now}.${mac}`;
}

/** Verify the cookie's structure + HMAC. Expiry is checked separately. */
export function verifyElevatedCookie(
    raw: string | undefined | null,
): ElevatedPayload | null {
    if (!raw) return null;
    const parts = raw.split(".");
    if (parts.length !== 4) return null;
    const [userId, sessionId, issuedAtStr, providedMac] = parts;
    const issuedAt = Number(issuedAtStr);
    if (
        !userId ||
        !sessionId ||
        !Number.isFinite(issuedAt) ||
        !/^[0-9a-f]{64}$/.test(providedMac)
    )
        return null;

    const expectedMac = macFor(userId, sessionId, issuedAt);
    const a = Buffer.from(expectedMac, "hex");
    const b = Buffer.from(providedMac, "hex");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;

    return { userId, sessionId, issuedAt };
}

export function isWithinReauthTtl(
    payload: ElevatedPayload,
    now = Date.now(),
): boolean {
    const ttlMs = env.ADMIN_REAUTH_TTL_MINUTES * 60 * 1000;
    return now - payload.issuedAt <= ttlMs;
}

export function isWithinMutationTtl(
    payload: ElevatedPayload,
    now = Date.now(),
): boolean {
    const ttlMs = env.ADMIN_MUTATION_TTL_MINUTES * 60 * 1000;
    return now - payload.issuedAt <= ttlMs;
}
