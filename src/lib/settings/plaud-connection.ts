import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { plaudConnections } from "@/db/schema";

/** Plaud connection status shared by layout onboarding and the dashboard per request. */
export const getPlaudConnection = cache(async (userId: string) => {
    const [row] = await db
        .select({ invalidatedAt: plaudConnections.invalidatedAt })
        .from(plaudConnections)
        .where(eq(plaudConnections.userId, userId))
        .limit(1);
    return row ?? null;
});
