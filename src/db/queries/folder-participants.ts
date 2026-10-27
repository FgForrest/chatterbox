import { type AnyColumn, eq, or, sql } from "drizzle-orm";
import { activeShareRecipientExistsCondition } from "@/db/queries/share-recipients";
import { folderShares } from "@/db/schema";
import { isOrgScopeVisible } from "@/lib/org/config";

/** The source folder owner and active colleagues with an accepted direct invitation. */
export function folderParticipantCondition(
    folderOwner: AnyColumn,
    participant: AnyColumn | string,
    folderId: AnyColumn,
) {
    return or(
        eq(folderOwner, participant),
        isOrgScopeVisible()
            ? sql`exists (select 1 from ${folderShares} participant_share
            where participant_share.folder_id = ${folderId}
              and participant_share.user_id = ${folderOwner}
              and participant_share.receiver_user_id = ${participant}
              and participant_share.state = 'accepted'
              and ${activeShareRecipientExistsCondition(participant)})`
            : sql`false`,
    );
}
