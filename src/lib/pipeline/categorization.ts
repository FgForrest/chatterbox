import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { AppError, ErrorCode } from "@/lib/errors";
import { assertCategorizableFolders } from "@/lib/folders/folders";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";

/** Maximum number of folder ids accepted by one categorization request. */
export const MAX_CATEGORIZATION_FOLDERS = 100;

/** Validate an owner's categorization target and resolve its folder defaults. */
export async function resolveCategorizationSelection(input: {
    ownerUserId: string;
    itemId: string;
    folderIds: readonly string[];
    seedProfiles?: boolean;
}) {
    const [item] = await db
        .select({ id: chatterItems.id, kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) throw new AppError(ErrorCode.NOT_FOUND, "Item not found", 404);

    const folderIds = [...new Set(input.folderIds)];
    const folders = await assertCategorizableFolders(
        input.ownerUserId,
        folderIds,
    );
    const resolution = await resolveProfileForPlacements({
        ownerUserId: input.ownerUserId,
        itemId: input.itemId,
        channel: item.kind,
        folderIds,
        view: "private",
        seedProfiles: input.seedProfiles,
    });
    return { item, folderIds, folders, resolution };
}
