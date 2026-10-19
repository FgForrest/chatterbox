import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { userSettings } from "@/db/schema";

/** The viewer's stored preferences, shared by server components in one request. */
export const getUserSettings = cache(async (userId: string) => {
    const [row] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
    return row;
});
