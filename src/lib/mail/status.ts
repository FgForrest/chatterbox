import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { mailDeliveryLog } from "@/db/schema";

/** Return a stable token for the newest mail accepted for one user. */
export async function latestMailDeliveryVersion(
    userId: string,
): Promise<string | null> {
    const [latest] = await db
        .select({ id: mailDeliveryLog.id, at: mailDeliveryLog.at })
        .from(mailDeliveryLog)
        .where(
            and(
                eq(mailDeliveryLog.userId, userId),
                eq(mailDeliveryLog.outcome, "accepted"),
                isNotNull(mailDeliveryLog.itemId),
            ),
        )
        .orderBy(desc(mailDeliveryLog.at), desc(mailDeliveryLog.id))
        .limit(1);
    return latest ? `${latest.at.toISOString()}:${latest.id}` : null;
}
