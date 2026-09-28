import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
    knowledgeAliases,
    people,
    personNotes,
    recordings,
    transcriptCorrections,
    transcriptions,
    transcriptSpeakerRejections,
    transcriptSpeakers,
    users,
} from "@/db/schema";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { moveFactsInTx } from "@/lib/knowledge/fact-merge";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { planSpeakerMerge } from "@/lib/knowledge/merge-plan";
import {
    lockOrgPeople,
    lockOrgPeopleShared,
    orgOwnedCondition,
} from "@/lib/knowledge/org-people";
import {
    bumpScopeInTx,
    scopesNamingInTx,
} from "@/lib/knowledge/scope-generation";

/** The bound on `people.displayName`, shared by every route that writes it. */
export const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * `personal` people belong to one account. `org` people are the
 * Organization's: one record everyone names speakers with, curated by the
 * organization account.
 */
export type PersonScope = "personal" | "org";

/** A person as feature code sees them: decrypted, never the stored row. */
export interface Person {
    id: string;
    displayName: string;
    primaryEmail: string | null;
    /**
     * The viewer's notes. For an Organization person these are the viewer's
     * own private notes, never anyone else's.
     */
    notes: string | null;
    /**
     * Set when this row is a tombstone left behind by a merge, naming the
     * person it redirects to. `listPeople` and `findPersonByEmail` filter
     * these out; `getPerson` does not, because callers hold ids that may
     * have been merged away since they were read, and answering "not found"
     * would lose the redirect that exists to prevent exactly that.
     */
    mergedIntoId: string | null;
    scope: PersonScope;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreatePersonArgs {
    userId: string;
    displayName: string;
    primaryEmail?: string | null;
    notes?: string | null;
    /** Who named an Organization person; `userId` is then the org account. */
    createdByUserId?: string | null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

interface PersonRow {
    id: string;
    userId: string;
    ownerRole: string;
    displayName: string;
    primaryEmail: string | null;
    notes: string | null;
    mergedIntoId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const personColumns = {
    id: people.id,
    userId: people.userId,
    ownerRole: users.role,
    displayName: people.displayName,
    primaryEmail: people.primaryEmail,
    notes: people.notes,
    mergedIntoId: people.mergedIntoId,
    createdAt: people.createdAt,
    updatedAt: people.updatedAt,
};

export { orgOwnedCondition };

/** SQL predicate: a person `userId` may see -- their own, or the Organization's. */
export function peopleVisibleTo(userId: string) {
    return or(eq(people.userId, userId), orgOwnedCondition(people.userId));
}

function toPerson(row: PersonRow, viewerNotes?: string | null): Person {
    const scope: PersonScope = row.ownerRole === "org" ? "org" : "personal";
    const notes = scope === "org" ? (viewerNotes ?? null) : row.notes;
    return {
        id: row.id,
        displayName: decryptText(row.displayName),
        primaryEmail: row.primaryEmail ? decryptText(row.primaryEmail) : null,
        notes: notes ? decryptText(notes) : null,
        mergedIntoId: row.mergedIntoId,
        scope,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

async function readPersonRow(
    executor: Executor,
    personId: string,
): Promise<PersonRow | null> {
    const [row] = await executor
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(eq(people.id, personId))
        .limit(1);
    return row ?? null;
}

async function viewerNotesFor(
    userId: string,
    personIds: string[],
): Promise<Map<string, string>> {
    if (personIds.length === 0) return new Map();
    const rows = await db
        .select({ personId: personNotes.personId, notes: personNotes.notes })
        .from(personNotes)
        .where(
            and(
                eq(personNotes.userId, userId),
                inArray(personNotes.personId, personIds),
            ),
        );
    return new Map(rows.map((row) => [row.personId, row.notes]));
}

/**
 * Create a person from a name the user typed.
 *
 * Deliberately requires no external identifier: naming a speaker in a
 * transcript supplies a name and nothing else. An email is optional, and
 * only some people will ever have one.
 */
export async function createPerson(args: CreatePersonArgs): Promise<Person> {
    return db.transaction(async (tx) => {
        const person = await createPersonInTx(tx, args);
        await bumpScopeInTx(tx, [args.userId]);
        return person;
    });
}

/**
 * `createPerson` inside a caller's transaction, e.g. with the change naming
 * them. The caller bumps `userId`'s scope generation at its end.
 */
export async function createPersonInTx(
    executor: Pick<typeof db, "select" | "insert">,
    {
        userId,
        displayName,
        primaryEmail,
        notes,
        createdByUserId,
    }: CreatePersonArgs,
): Promise<Person> {
    const trimmedName = displayName.trim();
    if (!trimmedName) {
        throw new Error("A person needs a name");
    }
    const email = primaryEmail?.trim() || null;

    const [created] = await executor
        .insert(people)
        .values({
            userId,
            displayName: encryptText(trimmedName),
            primaryEmail: email ? encryptText(email) : null,
            primaryEmailHash: email ? lookupHash(email) : null,
            notes: notes?.trim() ? encryptText(notes.trim()) : null,
            createdByUserId: createdByUserId ?? null,
        })
        .returning({ id: people.id });

    const row = created ? await readPersonRow(executor, created.id) : null;
    if (!row) throw new Error("Person was not created");
    return toPerson(row);
}

/**
 * Find a person by email address among those `userId` can see.
 *
 * Matches on the HMAC rather than the stored ciphertext, which is not
 * deterministic and could not be compared. Tombstoned losers of a merge are
 * excluded so a stale address never resolves to a row the user has already
 * folded away.
 */
export async function findPersonByEmail(
    userId: string,
    email: string,
): Promise<Person | null> {
    const [row] = await db
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(
            and(
                peopleVisibleTo(userId),
                eq(people.primaryEmailHash, lookupHash(email)),
                isNull(people.mergedIntoId),
            ),
        )
        .limit(1);

    return row ? toPerson(row) : null;
}

/**
 * The people `userId` can name speakers with: their own, and the
 * Organization's. Most recently updated first; tombstones excluded.
 */
export async function listPeople(userId: string): Promise<Person[]> {
    const rows = await db
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(and(peopleVisibleTo(userId), isNull(people.mergedIntoId)))
        .orderBy(sql`${people.updatedAt} desc`);

    const notes = await viewerNotesFor(
        userId,
        rows.filter((row) => row.ownerRole === "org").map((row) => row.id),
    );
    return rows.map((row) => toPerson(row, notes.get(row.id)));
}

/** Look up a person by id, tombstones included -- see `Person.mergedIntoId`. */
export async function getPerson(
    userId: string,
    personId: string,
): Promise<Person | null> {
    const [row] = await db
        .select(personColumns)
        .from(people)
        .innerJoin(users, eq(users.id, people.userId))
        .where(and(peopleVisibleTo(userId), eq(people.id, personId)))
        .limit(1);
    if (!row) return null;
    const notes =
        row.ownerRole === "org"
            ? (await viewerNotesFor(userId, [row.id])).get(row.id)
            : undefined;
    return toPerson(row, notes);
}

function curatorOnly(): AppError {
    return new AppError(
        ErrorCode.FORBIDDEN,
        "Only the organization account can change an Organization person",
        403,
    );
}

function personNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
}

/**
 * A person `actorId` may change: their own, which for the organization
 * account are the Organization's people. Everyone else may see an
 * Organization person but not change it.
 */
async function requireManageable(
    executor: Executor,
    actorId: string,
    personId: string,
): Promise<PersonRow> {
    const row = await readPersonRow(executor, personId);
    if (!row) throw personNotFound();
    if (row.userId === actorId) return row;
    if (row.ownerRole === "org") throw curatorOnly();
    throw personNotFound();
}

/**
 * Rename a person or change their email.
 *
 * An Organization person is renamed for everyone, in every recording that
 * names them -- private recordings included -- which is why only the
 * organization account may do it.
 */
export async function updatePerson(
    actorId: string,
    personId: string,
    changes: { displayName?: string; primaryEmail?: string | null },
): Promise<Person> {
    await db.transaction(async (tx) => {
        // Under the promotion lock: a promotion checks email uniqueness
        // against the Organization's people and must not race an edit of it.
        await lockOrgPeople(tx);
        await updatePersonInTx(tx, actorId, personId, changes);
        // A new name reads differently everywhere the person is named.
        await bumpScopeInTx(
            tx,
            await scopesNamingInTx(tx, { personIds: [personId] }),
        );
    });
    const updated = await getPerson(actorId, personId);
    if (!updated) throw personNotFound();
    return updated;
}

async function updatePersonInTx(
    tx: Tx,
    actorId: string,
    personId: string,
    changes: { displayName?: string; primaryEmail?: string | null },
): Promise<void> {
    const row = await requireManageable(tx, actorId, personId);
    if (row.mergedIntoId) throw personNotFound();

    const set: Partial<typeof people.$inferInsert> = { updatedAt: new Date() };
    if (changes.displayName !== undefined) {
        const name = changes.displayName.trim();
        if (!name) {
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                "A person needs a name",
                400,
                { field: "displayName" },
            );
        }
        set.displayName = encryptText(name);
    }
    if (changes.primaryEmail !== undefined) {
        const email = changes.primaryEmail?.trim() || null;
        if (email) {
            const holder = await findPersonByEmail(actorId, email);
            if (holder && holder.id !== personId) {
                throw new AppError(
                    ErrorCode.CONFLICT,
                    `${holder.displayName} already has that email address`,
                    409,
                    { field: "primaryEmail" },
                );
            }
        }
        set.primaryEmail = email ? encryptText(email) : null;
        set.primaryEmailHash = email ? lookupHash(email) : null;
    }

    await tx.update(people).set(set).where(eq(people.id, personId));
}

/**
 * Move `loserId`'s attributions onto `winnerId` and leave a tombstone.
 *
 * Works on person ids alone: an Organization person is named in many
 * accounts' transcripts, so every attribution row is moved, whoever's it
 * is. Callers authorize first.
 *
 * A transcript rewrite replaces its speaker rows under its recording's
 * lock, so the recordings of every transcript naming either person are
 * held first: otherwise a rewrite could re-insert a row this merge moved,
 * or move one it is about to.
 */
async function mergeInTx(
    tx: Tx,
    winnerId: string,
    loserId: string,
): Promise<void> {
    await lockRecordingsNaming(tx, [winnerId, loserId]);

    const attributionColumns = {
        id: transcriptSpeakers.id,
        transcriptionId: transcriptSpeakers.transcriptionId,
        label: transcriptSpeakers.label,
        status: transcriptSpeakers.status,
    };
    const winners = await tx
        .select(attributionColumns)
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.personId, winnerId));
    const losers = await tx
        .select(attributionColumns)
        .from(transcriptSpeakers)
        .where(eq(transcriptSpeakers.personId, loserId));

    const plan = planSpeakerMerge(winners, losers);
    const dropped = [...plan.dropLoserIds, ...plan.dropWinnerIds];
    if (dropped.length > 0) {
        await tx
            .delete(transcriptSpeakers)
            .where(inArray(transcriptSpeakers.id, dropped));
    }
    if (plan.repointLoserIds.length > 0) {
        await tx
            .update(transcriptSpeakers)
            .set({ personId: winnerId, updatedAt: new Date() })
            .where(inArray(transcriptSpeakers.id, plan.repointLoserIds));
    }

    // "Not this person" said about the loser is said about the same human.
    const loserRejections = await tx
        .select({
            userId: transcriptSpeakerRejections.userId,
            transcriptionId: transcriptSpeakerRejections.transcriptionId,
            label: transcriptSpeakerRejections.label,
        })
        .from(transcriptSpeakerRejections)
        .where(eq(transcriptSpeakerRejections.personId, loserId));
    if (loserRejections.length > 0) {
        await tx
            .insert(transcriptSpeakerRejections)
            .values(
                loserRejections.map((row) => ({ ...row, personId: winnerId })),
            )
            .onConflictDoNothing();
        await tx
            .delete(transcriptSpeakerRejections)
            .where(eq(transcriptSpeakerRejections.personId, loserId));
    }
    await settleContradictions(tx, winnerId);

    // Everyone's private notes about the loser follow the attributions.
    const loserNotes = await tx
        .select({ userId: personNotes.userId, notes: personNotes.notes })
        .from(personNotes)
        .where(eq(personNotes.personId, loserId));
    for (const note of loserNotes) {
        await appendOverlayNotes(tx, winnerId, note.userId, note.notes);
    }
    if (loserNotes.length > 0) {
        await tx.delete(personNotes).where(eq(personNotes.personId, loserId));
    }

    // The knowledge naming the loser follows: corrections (two never cover
    // the same words, so nothing collides), aliases (the survivor's own copy
    // of a name wins), and facts (combined where they then say the same).
    await tx
        .update(transcriptCorrections)
        .set({ targetPersonId: winnerId, updatedAt: new Date() })
        .where(eq(transcriptCorrections.targetPersonId, loserId));
    const other = alias(knowledgeAliases, "other");
    await tx
        .update(knowledgeAliases)
        .set({ personId: winnerId, updatedAt: new Date() })
        .where(
            and(
                eq(knowledgeAliases.personId, loserId),
                sql`not exists (${tx
                    .select({ id: other.id })
                    .from(other)
                    .where(
                        and(
                            eq(other.personId, winnerId),
                            eq(other.userId, knowledgeAliases.userId),
                            eq(other.kind, knowledgeAliases.kind),
                            eq(other.textHmac, knowledgeAliases.textHmac),
                            sql`${other.correctionId} is not distinct from ${knowledgeAliases.correctionId}`,
                        ),
                    )})`,
            ),
        );
    await tx
        .delete(knowledgeAliases)
        .where(eq(knowledgeAliases.personId, loserId));
    await moveFactsInTx(tx, { personId: loserId }, { personId: winnerId });

    // Chains collapse to the final winner rather than forming a linked
    // list nobody walks: anything already pointing at the loser is
    // repointed in the same transaction.
    //
    // The lookup key goes with the name it belonged to. A tombstone
    // exists to redirect an id, and holding the unique email hash would
    // reserve an address nothing displays and nothing can release.
    await tx
        .update(people)
        .set({
            mergedIntoId: winnerId,
            primaryEmailHash: null,
            updatedAt: new Date(),
        })
        .where(eq(people.id, loserId));
    await tx
        .update(people)
        .set({ mergedIntoId: winnerId, updatedAt: new Date() })
        .where(eq(people.mergedIntoId, loserId));
}

/**
 * Lock, in id order, the recordings of every transcript that names one of
 * `personIds` or rejects them for a label: the lock a transcript rewrite
 * takes, shared, so moving these people's rows waits for a rewrite in
 * progress and holds off the next one.
 */
async function lockRecordingsNaming(
    tx: Tx,
    personIds: string[],
): Promise<void> {
    const named = tx
        .select({ id: transcriptSpeakers.transcriptionId })
        .from(transcriptSpeakers)
        .where(inArray(transcriptSpeakers.personId, personIds));
    const rejected = tx
        .select({ id: transcriptSpeakerRejections.transcriptionId })
        .from(transcriptSpeakerRejections)
        .where(inArray(transcriptSpeakerRejections.personId, personIds));
    const corrected = tx
        .select({ id: transcriptCorrections.transcriptionId })
        .from(transcriptCorrections)
        .where(inArray(transcriptCorrections.targetPersonId, personIds));
    const touched = await tx
        .selectDistinct({ recordingId: transcriptions.recordingId })
        .from(transcriptions)
        .where(
            or(
                inArray(transcriptions.id, named),
                inArray(transcriptions.id, rejected),
                inArray(transcriptions.id, corrected),
            ),
        );
    if (touched.length === 0) return;
    await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            inArray(
                recordings.id,
                touched.map((row) => row.recordingId),
            ),
        )
        .orderBy(recordings.id)
        .for("share");
}

/**
 * A merge can meet two answers about one label that now name the same
 * person: "it is them" and "it is not them" (said about the other record
 * of that human). The confirmation stands and the rejection goes, as when a
 * person confirms someone they once rejected; a mere suggestion the
 * rejection rules out goes instead.
 */
async function settleContradictions(tx: Tx, personId: string): Promise<void> {
    // Both sides name `personId` on the same label of the same transcript.
    const sameAnswer = and(
        eq(transcriptSpeakers.personId, personId),
        eq(transcriptSpeakerRejections.personId, personId),
        eq(
            transcriptSpeakers.transcriptionId,
            transcriptSpeakerRejections.transcriptionId,
        ),
        eq(transcriptSpeakers.label, transcriptSpeakerRejections.label),
    );
    await tx.delete(transcriptSpeakerRejections).where(
        and(
            eq(transcriptSpeakerRejections.personId, personId),
            exists(
                tx
                    .select({ id: transcriptSpeakers.id })
                    .from(transcriptSpeakers)
                    .where(
                        and(
                            sameAnswer,
                            eq(transcriptSpeakers.status, "confirmed"),
                        ),
                    ),
            ),
        ),
    );
    await tx
        .delete(transcriptSpeakers)
        .where(
            and(
                eq(transcriptSpeakers.personId, personId),
                eq(transcriptSpeakers.status, "suggested"),
                exists(
                    tx
                        .select({ id: transcriptSpeakerRejections.id })
                        .from(transcriptSpeakerRejections)
                        .where(sameAnswer),
                ),
            ),
        );
}

/**
 * Fold `loserId` into `keepId`.
 *
 * Two people become one constantly: a name typed into the speaker picker and
 * the same human arriving later from a calendar invite are different rows
 * until somebody says otherwise.
 *
 * The hard part is not moving rows, it is the ones that cannot move.
 * `transcript_speakers` is unique on `(transcriptionId, label)`, so when both
 * people are attributed in the same transcript the loser's row has nowhere to
 * go. `planSpeakerMerge` decides which survives; the losing row is
 * dropped rather than repointed.
 *
 * The losing person row is kept as a tombstone carrying `mergedIntoId` so
 * that anything still holding the old id resolves to the winner instead of
 * dangling.
 *
 * `keepId` may itself be a tombstone -- the picker and the API both accept an
 * id that was merged away since the caller read it -- so it is resolved to
 * the person it redirects to before anything moves.
 *
 * `actorId` must be able to change the loser: their own person, or, for the
 * organization account, an Organization person. The target may be the
 * actor's own or an Organization person, so anyone can fold a private
 * duplicate into the shared record, but never the reverse.
 */
export async function mergePeople(
    actorId: string,
    keepId: string,
    loserId: string,
): Promise<void> {
    if (keepId === loserId) return;

    await db.transaction(async (tx) => {
        // Before anything is read: a share promoting either person decides
        // whose they are, and a merge must see the outcome.
        await lockOrgPeople(tx);
        const loser = await requireManageable(tx, actorId, loserId);
        const keep = await readPersonRow(tx, keepId);
        if (!keep || (keep.userId !== actorId && keep.ownerRole !== "org")) {
            throw personNotFound();
        }
        if (loser.ownerRole === "org" && keep.ownerRole !== "org") {
            throw curatorOnly();
        }

        // Every tombstone is repointed at the surviving person when its own
        // target is merged away (the collapse in `mergeInTx`), so a redirect
        // is never more than one hop deep and following it cannot loop.
        const winnerId = keep.mergedIntoId ?? keepId;
        if (winnerId === loserId) return;
        const scopes = await scopesNamingInTx(tx, {
            personIds: [winnerId, loserId],
        });
        await mergeInTx(tx, winnerId, loserId);
        if (loser.ownerRole !== "org" && keep.ownerRole === "org") {
            await moveNotesToOverlay(tx, loser, winnerId);
        }
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * Erase a person.
 *
 * A named third party asking to be removed is a data-subject request, so it
 * has to be one action. For a private person, attributions cascade with the
 * row; the transcript keeps its raw `speaker_N` label and simply loses the
 * overlay, which is the right outcome -- the recording is not the thing
 * being erased. An Organization person is named in other people's
 * transcripts too, so their attributions are unlinked rather than deleted.
 *
 * The tombstones of anyone merged into this person go with them. They hold
 * the same human's encrypted name and email, `mergedIntoId` carries no
 * foreign key so nothing cascades to them, and no surface lists them -- so
 * leaving them behind would quietly keep the data the request is about.
 */
export async function deletePerson(
    actorId: string,
    personId: string,
): Promise<void> {
    await db.transaction(async (tx) => {
        // Before anything is read: a share may be promoting this person,
        // and the private record it read would be the Organization's by
        // the time it is deleted.
        await lockOrgPeople(tx);
        const row = await requireManageable(tx, actorId, personId);
        // Read before the delete: it takes everyone's aliases, notes, facts
        // and corrections naming this person or their tombstones.
        const doomed = await tx
            .select({ id: people.id })
            .from(people)
            .where(
                or(eq(people.id, personId), eq(people.mergedIntoId, personId)),
            );
        const scopes = await scopesNamingInTx(tx, {
            personIds: doomed.map((person) => person.id),
        });
        if (row.ownerRole === "org") {
            await tx
                .update(transcriptSpeakers)
                .set({ personId: null, updatedAt: new Date() })
                .where(eq(transcriptSpeakers.personId, personId));
        }
        await tx
            .delete(people)
            .where(
                or(eq(people.id, personId), eq(people.mergedIntoId, personId)),
            );
        await bumpScopeInTx(tx, scopes);
    });
}

/**
 * Add `notes` (ciphertext) to `userId`'s private notes on a person, after
 * whatever they already wrote there -- two records of one human each carried
 * something, and neither may be dropped.
 */
async function appendOverlayNotes(
    tx: Tx,
    personId: string,
    userId: string,
    notes: string,
): Promise<void> {
    const [current] = await tx
        .select({ id: personNotes.id, notes: personNotes.notes })
        .from(personNotes)
        .where(
            and(
                eq(personNotes.personId, personId),
                eq(personNotes.userId, userId),
            ),
        )
        .limit(1);
    if (!current) {
        await tx.insert(personNotes).values({ personId, userId, notes });
        return;
    }
    const combined = [decryptText(current.notes), decryptText(notes)]
        .filter((text) => text.trim())
        .join("\n\n");
    await tx
        .update(personNotes)
        .set({ notes: encryptText(combined), updatedAt: new Date() })
        .where(eq(personNotes.id, current.id));
}

async function moveNotesToOverlay(
    tx: Tx,
    from: Pick<PersonRow, "id" | "userId" | "notes">,
    orgPersonId: string,
): Promise<void> {
    if (!from.notes) return;
    await appendOverlayNotes(tx, orgPersonId, from.userId, from.notes);
    await tx
        .update(people)
        .set({ notes: null, updatedAt: new Date() })
        .where(eq(people.id, from.id));
}

/** Store `userId`'s private notes on an Organization person. */
export async function addPersonNotes(
    personId: string,
    userId: string,
    notes: string,
): Promise<void> {
    const trimmed = notes.trim();
    if (!trimmed) return;
    await db.transaction(async (tx) => {
        await lockOrgPeopleShared(tx);
        await appendOverlayNotes(tx, personId, userId, encryptText(trimmed));
        await bumpScopeInTx(tx, [userId]);
    });
}

/**
 * What sharing would make of a person, decided without writing anything
 * (`promotePersonInTx` acts on it): the Organization person they are or
 * would become, and for a private one the record promoted and the
 * Organization person with the same email it would fold into. Null when
 * they are gone. A merged-away id stands for the one it was folded into.
 */
export interface PersonPromotion {
    /** The Organization person's id, now or once promoted. */
    orgPersonId: string;
    /** The private record to promote; null when already the Organization's. */
    row: PersonRow | null;
    foldInto: string | null;
}

export async function planPersonPromotionInTx(
    tx: Tx,
    personId: string,
    orgUserId: string,
): Promise<PersonPromotion | null> {
    const row = await readPersonRow(tx, personId);
    if (!row) return null;
    if (row.mergedIntoId) {
        return planPersonPromotionInTx(tx, row.mergedIntoId, orgUserId);
    }
    if (row.userId === orgUserId || row.ownerRole === "org") {
        return { orgPersonId: row.id, row: null, foldInto: null };
    }
    const [emailRow] = await tx
        .select({ hash: people.primaryEmailHash })
        .from(people)
        .where(eq(people.id, row.id))
        .limit(1);
    if (emailRow?.hash) {
        const [known] = await tx
            .select({ id: people.id })
            .from(people)
            .where(
                and(
                    eq(people.userId, orgUserId),
                    eq(people.primaryEmailHash, emailRow.hash),
                    isNull(people.mergedIntoId),
                ),
            )
            .limit(1);
        if (known) return { orgPersonId: known.id, row, foldInto: known.id };
    }
    return { orgPersonId: row.id, row, foldInto: null };
}

/**
 * Make a private person an Organization person.
 *
 * Promotion reassigns the row rather than copying it, so every attribution
 * -- the owner's private ones included -- keeps pointing at the same id and
 * the owner's knowledge base cannot drift from the Organization's. When the
 * Organization already knows someone with the same email, the private
 * record is folded into theirs instead. The owner's notes are never
 * promoted: they move to that owner's private overlay.
 *
 * Returns the id of the Organization person. Permanent: unsharing the
 * recording that caused it does not demote anyone.
 */
export async function promotePersonInTx(
    tx: Tx,
    personId: string,
    orgUserId: string,
): Promise<string | null> {
    const plan = await planPersonPromotionInTx(tx, personId, orgUserId);
    if (!plan) return null;
    const { row, foldInto } = plan;
    if (!row) return plan.orgPersonId;
    if (foldInto) {
        await mergeInTx(tx, foldInto, row.id);
        await moveNotesToOverlay(tx, row, foldInto);
        return foldInto;
    }

    await moveNotesToOverlay(tx, row, row.id);
    const [promoted] = await tx
        .update(people)
        .set({
            userId: orgUserId,
            createdByUserId: row.userId,
            updatedAt: new Date(),
        })
        .where(eq(people.id, row.id))
        .returning({ id: people.id });
    // Deleted since it was read: there is nobody to promote.
    return promoted?.id ?? null;
}
