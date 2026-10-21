import { and, eq } from "drizzle-orm";
import type { db } from "@/db";
import { knowledgeEntities, people } from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { AppError, ErrorCode } from "@/lib/errors";
import type { KnowledgeTarget } from "@/lib/knowledge/aliases";
import { visibleOwnerCondition } from "@/lib/knowledge/org-people";
import { assertOwnScopeWritable, isOrgAccount } from "@/lib/org/config";

/** Authorize an Almanac row's owner without granting access to other private scopes. */
export async function assertAlmanacOwner(
    actorUserId: string,
    ownerUserId: string,
    notFoundError?: AppError,
): Promise<void> {
    if (await isOrgAccount(ownerUserId)) {
        if (await userCuratesOrganizationNow(actorUserId)) return;
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only an Organization curator can change the Organization's Almanac",
            403,
        );
    }
    if (ownerUserId === actorUserId) return;
    throw (
        notFoundError ??
        new AppError(ErrorCode.NOT_FOUND, "Entry not found", 404)
    );
}

/** Choose shared knowledge only for a curator's shared subject; private subjects stay private. */
export async function almanacTargetScope(
    executor: Pick<typeof db, "select">,
    actorUserId: string,
    target: KnowledgeTarget,
): Promise<string> {
    const table = "personId" in target ? people : knowledgeEntities;
    const id = "personId" in target ? target.personId : target.entityId;
    const [row] = await executor
        .select({ userId: table.userId })
        .from(table)
        .where(
            and(
                eq(table.id, id),
                visibleOwnerCondition(table.userId, actorUserId),
            ),
        )
        .limit(1);
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Entry not found", 404);
    await assertOwnScopeWritable(actorUserId);
    if (
        (await isOrgAccount(row.userId)) &&
        (await userCuratesOrganizationNow(actorUserId))
    ) {
        return row.userId;
    }
    return actorUserId;
}
