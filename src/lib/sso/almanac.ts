import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { people, personEmails, users } from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { personNamesFit } from "@/lib/knowledge/duplicate-score";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { createPersonInTx } from "@/lib/knowledge/people";
import {
    bumpScopeInTx,
    scopesNamingInTx,
} from "@/lib/knowledge/scope-generation";
import { isInternalMailAddress } from "@/lib/mail/internal-address";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface SsoAlmanacUser {
    id: string;
    name: string | null;
    email: string;
}

async function isSomeoneElsesRecord(
    tx: Tx,
    record: { name: string; createdByUserId: string | null },
    user: SsoAlmanacUser,
    providerName: string,
    email: string,
): Promise<boolean> {
    if (
        record.createdByUserId === user.id ||
        record.name.trim().toLowerCase() === email.toLowerCase() ||
        personNamesFit(record.name, providerName)
    ) {
        return false;
    }
    // afterSsoSession stamps lastSsoLoginAt only after recording the person.
    const [account] = await tx
        .select({ lastSsoLoginAt: users.lastSsoLoginAt })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1);
    return account?.lastSsoLoginAt === null;
}

async function releaseAddressInTx(
    tx: Tx,
    personId: string,
    emailHash: string,
): Promise<void> {
    await tx
        .update(people)
        .set({
            primaryEmail: null,
            primaryEmailHash: null,
            updatedAt: new Date(),
        })
        .where(eq(people.id, personId));
    await tx
        .delete(personEmails)
        .where(
            and(
                eq(personEmails.personId, personId),
                eq(personEmails.emailHash, emailHash),
            ),
        );
    await bumpScopeInTx(
        tx,
        await scopesNamingInTx(tx, { personIds: [personId] }),
    );
}

/**
 * Keep the person who signed in through the identity provider in the
 * Almanac: the Organization's when its scope is enabled, else their own.
 * Matched by email; a missing record is created and a known one takes the
 * provider's current name. Nicknames, notes and facts are left alone.
 *
 * Members can put an address on an Organization person before its holder
 * ever signs in. So at the first sign-in, a record the holder did not create
 * and whose name does not fit the provider's is someone else's: it keeps its
 * name and loses the address, and the holder gets a new record. From then on
 * the record is the holder's and follows the provider, whatever the new name
 * is. A provider that gives no name proves nothing and renames nothing.
 *
 * Returns the person's id, or null for an internal routing address.
 */
export async function recordSsoUserInAlmanac(
    user: SsoAlmanacUser,
): Promise<string | null> {
    const email = user.email.trim();
    if (isInternalMailAddress(email)) return null;
    const trimmedName = user.name?.trim();
    const providerName =
        trimmedName && trimmedName.toLowerCase() !== email.toLowerCase()
            ? trimmedName
            : null;
    const orgUserId = isOrgScopeEnabled() ? await getOrgUserId() : null;
    const ownerId = orgUserId ?? user.id;
    const emailHash = lookupHash(email);

    return db.transaction(async (tx) => {
        // Serialises against promotions and merges, which check the
        // Organization's emails, and against this user's other logins.
        await lockOrgPeople(tx);
        const [known] = await tx
            .select({
                id: people.id,
                displayName: people.displayName,
                createdByUserId: people.createdByUserId,
            })
            .from(people)
            .where(
                and(
                    eq(people.userId, ownerId),
                    eq(people.primaryEmailHash, emailHash),
                    isNull(people.mergedIntoId),
                ),
            )
            .limit(1);

        if (known) {
            const knownName = decryptText(known.displayName);
            const someoneElses =
                orgUserId &&
                providerName &&
                (await isSomeoneElsesRecord(
                    tx,
                    {
                        name: knownName,
                        createdByUserId: known.createdByUserId,
                    },
                    user,
                    providerName,
                    email,
                ));
            if (!someoneElses) {
                if (providerName && knownName !== providerName) {
                    await tx
                        .update(people)
                        .set({
                            displayName: encryptText(providerName),
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
            await releaseAddressInTx(tx, known.id, emailHash);
            console.warn(
                `[sso] first sign-in of user ${user.id}: person ${known.id} has another name, so the address moved to a new record`,
            );
        }

        const person = await createPersonInTx(tx, {
            userId: ownerId,
            displayName: providerName ?? email,
            primaryEmail: email,
            createdByUserId: orgUserId ? user.id : null,
        });
        await bumpScopeInTx(tx, [ownerId]);
        return person.id;
    });
}
