/**
 * Adding a thing with its nicknames, all or nothing. Apart from
 * `entities.ts`, which `aliases.ts` reads.
 */

import { db } from "@/db";
import { AppError, ErrorCode } from "@/lib/errors";
import { addAliasInTx } from "@/lib/knowledge/aliases";
import {
    createEntityInTx,
    type Entity,
    getEntity,
} from "@/lib/knowledge/entities";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";

/**
 * Create a thing in the actor's own scope with its nicknames (one given
 * twice counts once). 409 with `details.existingId` as `createEntity`.
 */
export async function createEntityWithNicknames(
    actorUserId: string,
    spec: { typeKey: string; name: string; description?: string | null },
    nicknames: readonly string[],
): Promise<Entity> {
    const id = await db.transaction(async (tx) => {
        await lockOrgPeople(tx);
        const created = await createEntityInTx(tx, actorUserId, spec);
        for (const nickname of nicknames) {
            await addAliasInTx(
                tx,
                actorUserId,
                { entityId: created },
                nickname,
            );
        }
        await bumpScopeInTx(tx, [actorUserId]);
        return created;
    });
    const entity = await getEntity(actorUserId, id);
    if (!entity) {
        throw new AppError(ErrorCode.NOT_FOUND, "Entity not found", 404);
    }
    return entity;
}
