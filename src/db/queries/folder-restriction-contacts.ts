import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { restrictedFolderVisibleCondition } from "@/db/queries/restricted-folders";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import { recordingFolders, userAccessStates, users } from "@/db/schema";
import { env } from "@/lib/env";
import { isIdpAuthorization } from "@/lib/identity/factory";

/** Resolve contact disclosure through the shared folder visibility predicate without live verification. */
export async function readableRestrictionContactFolder(
    viewer: { userId: string; isCurator: boolean },
    folderId: string,
    orgUserId: string,
) {
    const [folder] = await db
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                eq(recordingFolders.userId, orgUserId),
                eq(recordingFolders.kind, "custom"),
                restrictedFolderVisibleCondition(viewer),
            ),
        )
        .limit(1);
    return folder ?? null;
}

/** Read capped curators and the eligible creator from one stored authorization snapshot. */
export async function storedFolderRestrictionContacts(
    folderId: string,
    orgUserId: string,
) {
    const idp = isIdpAuthorization();
    const cutoff = new Date(
        Date.now() - env.AUTHZ_VERIFICATION_MAX_AGE * 1000,
    ).toISOString();
    return db.execute<{
        id: string;
        name: string | null;
        email: string;
        isCurator: boolean;
    }>(sql`
        with eligible as (
            select ${users.id} as id, ${users.name} as name, ${users.email} as email,
                ${
                    idp
                        ? sql`${userAccessStates.capabilities} @> '["org.curate"]'::jsonb`
                        : sql`${users.id} = ${orgUserId}`
                } as curator,
                (${users.role} <> 'org' and exists (
                    select 1 from ${recordingFolders}
                    where ${recordingFolders.id} = ${folderId}
                      and ${recordingFolders.userId} = ${orgUserId}
                      and ${recordingFolders.kind} = 'custom'
                      and ${recordingFolders.createdByUserId} = ${users.id}
                )) as creator
            from ${users}
            left join ${userAccessStates} on ${userAccessStates.userId} = ${users.id}
            where ${
                idp
                    ? sql`${activeShareRecipientCondition()}
                    and ${userAccessStates.verifiedAt} > ${cutoff}::timestamp`
                    : sql`${users.suspendedAt} is null`
            }
        ), curators as (
            select id, name, email from eligible where curator
            order by name, email, id limit 50
        )
        select id, name, email, true as "isCurator" from curators
        union all
        select id, name, email, false as "isCurator" from eligible
        where creator and not exists (select 1 from curators where curators.id = eligible.id)
        order by "isCurator" desc, name, email, id
    `);
}
