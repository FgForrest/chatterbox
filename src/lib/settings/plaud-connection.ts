import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";
import { getPlaudTokenExpiries } from "@/lib/plaud/stored-expiries";

/** Plaud connection status shared by layout onboarding and the dashboard per request. */
export const getPlaudConnection = cache(async (userId: string) => {
    const [row] = await db
        .select({
            invalidatedAt: plaudConnections.invalidatedAt,
            bearerToken: plaudConnections.bearerToken,
            refreshToken: plaudConnections.refreshToken,
            accessExpiresAt: plaudConnections.accessExpiresAt,
            sessionExpiresAt: plaudConnections.sessionExpiresAt,
            updatedAt: plaudConnections.updatedAt,
        })
        .from(plaudConnections)
        .where(eq(plaudConnections.userId, userId))
        .limit(1);
    if (!row) return null;
    return {
        invalidatedAt: row.invalidatedAt,
        sessionExpiresAt: getPlaudTokenExpiries(row).sessionExpiresAt,
        updatedAt: row.updatedAt,
    };
});
