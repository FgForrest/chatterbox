import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { resolveTimeZone, TIME_ZONE_COOKIE } from "@/lib/i18n/time-zone";
import { getOrgUserId } from "@/lib/org/config";

const preference = cache(async (userId: string) => {
    const [user] = await db
        .select({ timeZone: users.timeZone })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
    return user?.timeZone ?? null;
});

/** Resolve an authenticated HTTP caller with their optional browser cookie. */
export function requestTimeZone(
    userId: string,
    request: Request,
): Promise<string> {
    const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${TIME_ZONE_COOKIE}=`))
        ?.slice(TIME_ZONE_COOKIE.length + 1);
    return userTimeZone(userId, cookie);
}

/** Resolve a caller's zone; background callers omit the browser cookie. */
export const userTimeZone = cache(
    async (userId?: string, cookie?: string | null): Promise<string> => {
        const orgUserId = await getOrgUserId();
        const [user, organization] = await Promise.all([
            userId ? preference(userId) : null,
            orgUserId ? preference(orgUserId) : null,
        ]);
        return resolveTimeZone({ user, cookie, organization });
    },
);
