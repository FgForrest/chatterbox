import { eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { meetingFolderVisibility } from "@/db/queries/meeting-folder-visibility";
import { receivedMeetingFolderNodes } from "@/db/queries/received-meeting-folders";
import { restrictedFolderVisibleCondition } from "@/db/queries/restricted-folders";
import { recordingFolders } from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";

/** Batch the viewer's folder metadata and received aliases for detail, lists and reminder paths. */
export async function meetingFolderNavigation(
    userId: string,
    orgUserId: string | null,
) {
    const isCurator = await userCuratesOrganizationNow(userId);
    const [folders, received] = await Promise.all([
        db
            .select({
                id: recordingFolders.id,
                name: recordingFolders.name,
                userId: recordingFolders.userId,
                parentId: recordingFolders.parentId,
                restricted: sql<boolean>`${recordingFolders.restrictedAt} is not null`,
                access: sql<boolean>`${restrictedFolderVisibleCondition({ userId, isCurator })}`,
            })
            .from(recordingFolders)
            .where(
                or(
                    meetingFolderVisibility(userId, orgUserId, isCurator),
                    orgUserId
                        ? eq(recordingFolders.userId, orgUserId)
                        : undefined,
                ),
            ),
        receivedMeetingFolderNodes(db, userId),
    ]);
    const aliases = new Map(
        received.map((folder) => [folder.sourceId, folder]),
    );
    const visible = folders.map(({ restricted, access, ...folder }) => {
        const received =
            folder.userId !== userId ? aliases.get(folder.id) : undefined;
        return {
            ...folder,
            ...(restricted ? { restricted: true as const, access } : {}),
            id: received?.id ?? folder.id,
            name: decryptText(received?.name ?? folder.name),
            parentId: received
                ? received.parentId
                : folder.userId === userId || folder.userId === orgUserId
                  ? folder.parentId
                  : null,
        };
    });
    const bySource = new Map(
        folders.map((folder, index) => [folder.id, visible[index]]),
    );
    const nodes = new Map(visible.map((folder) => [folder.id, folder]));
    return {
        project: (folder: { id: string }) =>
            bySource.get(folder.id) ?? nodes.get(folder.id),
        path: (placements: readonly { id: string }[]) => {
            const first = [...placements]
                .sort((a, b) => a.id.localeCompare(b.id))
                .flatMap((folder) => {
                    const node =
                        bySource.get(folder.id) ?? nodes.get(folder.id);
                    return node ? [node] : [];
                })[0];
            const names: string[] = [];
            const seen = new Set<string>();
            let current: (typeof visible)[number] | undefined = first;
            while (current && !seen.has(current.id)) {
                seen.add(current.id);
                names.unshift(current.name);
                current = current.parentId
                    ? nodes.get(current.parentId)
                    : undefined;
            }
            return names.join(" / ");
        },
    };
}
