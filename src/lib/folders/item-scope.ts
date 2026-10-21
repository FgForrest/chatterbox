import {
    type AlmanacUsageRow,
    almanacScopeUsage,
} from "@/db/queries/almanac-usage";
import { queryItemScopeFolderIds } from "@/db/queries/folder-scope";
import { getOrgUserId } from "@/lib/org/config";
import { isRecordingShared } from "@/lib/sharing/shared";

const RECENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The sorted union of an owner's item placements and their descendant folders. */
export async function itemScopeFolderIds(
    itemId: string,
    view: "private" | "org",
    ownerUserId: string,
): Promise<string[]> {
    const orgUserId = await getOrgUserId();
    const scopeView =
        orgUserId && (await isRecordingShared(itemId, orgUserId))
            ? "org"
            : view;
    return queryItemScopeFolderIds({
        itemId,
        view: scopeView,
        ownerUserId,
        orgUserId,
    });
}

/** Usage of people and entities in the other items of an item's folder scope. */
export async function itemScopeAlmanacUsage(
    itemId: string,
    view: "private" | "org",
    ownerUserId: string,
): Promise<AlmanacUsageRow[]> {
    const orgUserId = await getOrgUserId();
    const scopeView =
        orgUserId && (await isRecordingShared(itemId, orgUserId))
            ? "org"
            : view;
    const scopeFolderIds = await queryItemScopeFolderIds({
        itemId,
        view: scopeView,
        ownerUserId,
        orgUserId,
    });
    return almanacScopeUsage({
        ownerUserId,
        orgUserId,
        itemId,
        view: scopeView,
        scopeFolderIds,
        recentSince: new Date(Date.now() - RECENT_DAYS * DAY_MS),
    });
}
