import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { listProviderRecoveryRowsInTx } from "@/db/queries/pipeline";
import { users } from "@/db/schema";
import { env } from "@/lib/env";
import { nudge } from "@/lib/jobs/nudge";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Request recovery for at most 200 recent items, at most 20 per owner. */
export async function requestProviderRecoveryInTx(
    tx: Tx,
    userId: string,
): Promise<number> {
    const [organization] =
        !env.IS_HOSTED && env.SELF_HOST_MODE === "shared"
            ? await tx
                  .select({ id: users.id })
                  .from(users)
                  .where(and(eq(users.id, userId), eq(users.role, "org")))
                  .limit(1)
            : [];
    const rows = await listProviderRecoveryRowsInTx(
        tx,
        userId,
        Boolean(organization),
    );
    let requested = 0;
    for (const row of rows) {
        if (
            await requestAdvanceInTx(tx, { ...row, reason: "provider-changed" })
        )
            requested++;
    }
    return requested;
}

/** Request the same bounded recovery explicitly, then wake the worker. */
export async function requestProviderRecovery(userId: string): Promise<number> {
    const requested = await db.transaction((tx) =>
        requestProviderRecoveryInTx(tx, userId),
    );
    if (requested > 0) nudge();
    return requested;
}
