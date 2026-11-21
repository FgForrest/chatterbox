import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { itemShares } from "@/db/schema";
import { env } from "@/lib/env";
import { organizationForDeployment } from "@/lib/folders/hierarchy";
import { isOrgScopeVisible } from "@/lib/org/config";
import type { FolderOrganization } from "@/types/folder";

/** Read the viewer's accepted item shares used by the dashboard. */
export function listDashboardReceivedShares(userId: string) {
    if (!isOrgScopeVisible()) return Promise.resolve([]);
    return db
        .select({
            id: itemShares.id,
            itemId: itemShares.itemId,
            version: itemShares.version,
            filingFolderId: itemShares.filingFolderId,
        })
        .from(itemShares)
        .where(
            and(
                eq(itemShares.receiverUserId, userId),
                eq(itemShares.state, "accepted"),
            ),
        );
}

/** Build the dashboard folder snapshot, including received item placements. */
export function dashboardFolderOrganization(
    organization: FolderOrganization,
    receivedShares: ReadonlyArray<{
        itemId: string;
        filingFolderId: string | null;
    }>,
): FolderOrganization {
    const visible = organizationForDeployment(organization, {
        isHosted: env.IS_HOSTED,
        selfHostMode: env.SELF_HOST_MODE,
    });
    return {
        ...visible,
        assignments: [
            ...visible.assignments,
            ...receivedShares.flatMap(({ itemId, filingFolderId }) =>
                filingFolderId
                    ? [{ recordingId: itemId, folderId: filingFolderId }]
                    : [],
            ),
        ],
    };
}
