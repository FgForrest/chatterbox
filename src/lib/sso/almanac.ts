import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { people } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { createPersonInTx } from "@/lib/knowledge/people";
import {
    bumpScopeInTx,
    scopesNamingInTx,
} from "@/lib/knowledge/scope-generation";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

export interface SsoAlmanacUser {
    id: string;
    name: string | null;
    email: string;
}

/**
 * Keep the person who signed in through the identity provider in the
 * Almanac: the Organization's when its scope is enabled, else their own.
 * Matched by email; a missing record is created and a known one takes the
 * provider's current name. Nicknames, notes and facts are left alone.
 *
 * Returns the person's id.
 */
export async function recordSsoUserInAlmanac(
    user: SsoAlmanacUser,
): Promise<string> {
    const email = user.email.trim();
    const name = user.name?.trim() || email;
    const orgUserId = isOrgScopeEnabled() ? await getOrgUserId() : null;
    const ownerId = orgUserId ?? user.id;

    return db.transaction(async (tx) => {
        // Serialises against promotions and merges, which check the
        // Organization's emails, and against this user's other logins.
        await lockOrgPeople(tx);
        const [known] = await tx
            .select({ id: people.id, displayName: people.displayName })
            .from(people)
            .where(
                and(
                    eq(people.userId, ownerId),
                    eq(people.primaryEmailHash, lookupHash(email)),
                    isNull(people.mergedIntoId),
                ),
            )
            .limit(1);

        if (known) {
            if (decryptText(known.displayName) !== name) {
                await tx
                    .update(people)
                    .set({
                        displayName: encryptText(name),
                        updatedAt: new Date(),
                    })
                    .where(eq(people.id, known.id));
                await bumpScopeInTx(
                    tx,
                    await scopesNamingInTx(tx, { personIds: [known.id] }),
                );
            }
            return known.id;
        }

        const person = await createPersonInTx(tx, {
            userId: ownerId,
            displayName: name,
            primaryEmail: email,
            createdByUserId: orgUserId ? user.id : null,
        });
        await bumpScopeInTx(tx, [ownerId]);
        return person.id;
    });
}
