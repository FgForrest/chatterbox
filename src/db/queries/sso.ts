import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { instanceState, sessions } from "@/db/schema";

const SSO_SESSIONS_MARKER = "sso_sessions_revoked";

/**
 * End every session once, the first time the instance starts with single
 * sign-on: sessions opened with a password must not outlive the switch.
 * A marker row makes it once per switch, across every app process.
 *
 * Returns how many sessions were ended, or null when it had already run.
 */
export async function revokeSessionsOnSsoSwitch(): Promise<number | null> {
    return db.transaction(async (tx) => {
        await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('riffado:sso-sessions', 0))`,
        );
        const [marker] = await tx
            .select({ key: instanceState.key })
            .from(instanceState)
            .where(eq(instanceState.key, SSO_SESSIONS_MARKER))
            .limit(1);
        if (marker) return null;

        const ended = await tx.delete(sessions).returning({ id: sessions.id });
        await tx.insert(instanceState).values({
            key: SSO_SESSIONS_MARKER,
            value: new Date().toISOString(),
        });
        return ended.length;
    });
}

/**
 * Forget that sessions were ended, so switching single sign-on on again
 * later ends the password sessions opened in between.
 */
export async function clearSsoSessionsMarker(): Promise<void> {
    await db
        .delete(instanceState)
        .where(eq(instanceState.key, SSO_SESSIONS_MARKER));
}
