import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    knowledgeAliases,
    knowledgeEntities,
    people,
    personEmails,
    recordingTasks,
    transcriptions,
    transcriptSpeakers,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    type DuplicateKind,
    proposedSurvivor,
} from "@/lib/knowledge/duplicate-score";
import {
    loadDuplicateRecords,
    requireDuplicateCurator,
} from "@/lib/knowledge/duplicates";
import { mergeEntities } from "@/lib/knowledge/entities";
import { type MergeChoices, mergeState } from "@/lib/knowledge/merge-choices";
import { mergePeople } from "@/lib/knowledge/people";
import { replanExports } from "@/lib/knowledge/route-helpers";
import { scopesNamingInTx } from "@/lib/knowledge/scope-generation";
import { sharedItemCondition } from "@/lib/sharing/shared";

/** Organization-only comparison, with shared items and tasks and no colleagues' private evidence. */
export async function compareDuplicates(
    actorId: string,
    kind: DuplicateKind,
    left: string,
    right: string,
) {
    const scope = await requireDuplicateCurator(actorId);
    const ids = [left, right];
    const state = await mergeState(db, scope, kind, ids);
    const { records } = await loadDuplicateRecords(scope, kind, ids);
    const column =
        kind === "person"
            ? knowledgeAliases.personId
            : knowledgeAliases.entityId;
    const [aliases, emails, appearancePages, taskPages] = await Promise.all([
        db
            .select({
                recordId: column,
                kind: knowledgeAliases.kind,
                text: knowledgeAliases.text,
            })
            .from(knowledgeAliases)
            .where(
                and(eq(knowledgeAliases.userId, scope), inArray(column, ids)),
            )
            .orderBy(knowledgeAliases.id)
            .limit(1001),
        kind === "person"
            ? db
                  .select({
                      personId: personEmails.personId,
                      email: personEmails.email,
                  })
                  .from(personEmails)
                  .where(
                      and(
                          eq(personEmails.userId, scope),
                          inArray(personEmails.personId, ids),
                      ),
                  )
                  .orderBy(personEmails.emailHash)
                  .limit(1001)
            : [],
        kind === "person"
            ? Promise.all(
                  ids.map((id) =>
                      db
                          .selectDistinct({
                              personId: transcriptSpeakers.personId,
                              itemId: chatterItems.id,
                              title: chatterItems.title,
                          })
                          .from(transcriptSpeakers)
                          .innerJoin(
                              transcriptions,
                              eq(
                                  transcriptions.id,
                                  transcriptSpeakers.transcriptionId,
                              ),
                          )
                          .innerJoin(
                              chatterItems,
                              and(
                                  eq(
                                      chatterItems.id,
                                      transcriptions.recordingId,
                                  ),
                                  eq(
                                      chatterItems.userId,
                                      transcriptions.userId,
                                  ),
                              ),
                          )
                          .where(
                              and(
                                  eq(transcriptSpeakers.personId, id),
                                  eq(transcriptSpeakers.status, "confirmed"),
                                  or(
                                      eq(transcriptSpeakers.userId, scope),
                                      eq(
                                          transcriptSpeakers.userId,
                                          transcriptions.userId,
                                      ),
                                  ),
                                  isNull(chatterItems.deletedAt),
                                  sharedItemCondition(scope),
                              ),
                          )
                          .orderBy(chatterItems.id)
                          .limit(101),
                  ),
              )
            : [],
        kind === "person"
            ? Promise.all(
                  ids.map((id) =>
                      db
                          .select({
                              id: recordingTasks.id,
                              personId: recordingTasks.assigneePersonId,
                              itemId: chatterItems.id,
                              text: recordingTasks.text,
                          })
                          .from(recordingTasks)
                          .innerJoin(
                              chatterItems,
                              and(
                                  eq(chatterItems.id, recordingTasks.itemId),
                                  eq(
                                      chatterItems.userId,
                                      recordingTasks.userId,
                                  ),
                              ),
                          )
                          .where(
                              and(
                                  eq(recordingTasks.assigneePersonId, id),
                                  eq(recordingTasks.status, "open"),
                                  isNull(chatterItems.deletedAt),
                                  sharedItemCondition(scope),
                              ),
                          )
                          .orderBy(recordingTasks.id)
                          .limit(101),
                  ),
              )
            : [],
    ]);
    const appearances = appearancePages.flat();
    const tasks = taskPages.flat();
    if (aliases.length > 1000 || emails.length > 1000)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Too many names or emails to compare at once",
            409,
            { reason: "too_many_forms" },
        );
    const personIds = state.facts.flatMap((fact) =>
        [fact.subjectPersonId, fact.objectPersonId].filter((id): id is string =>
            Boolean(id),
        ),
    );
    const entityIds = state.facts.flatMap((fact) =>
        [fact.subjectEntityId, fact.objectEntityId].filter((id): id is string =>
            Boolean(id),
        ),
    );
    const [personNames, entityNames] = await Promise.all([
        personIds.length
            ? db
                  .select({ id: people.id, name: people.displayName })
                  .from(people)
                  .where(
                      and(
                          eq(people.userId, scope),
                          inArray(people.id, personIds),
                      ),
                  )
            : [],
        entityIds.length
            ? db
                  .select({
                      id: knowledgeEntities.id,
                      name: knowledgeEntities.name,
                  })
                  .from(knowledgeEntities)
                  .where(
                      and(
                          eq(knowledgeEntities.userId, scope),
                          inArray(knowledgeEntities.id, entityIds),
                      ),
                  )
            : [],
    ]);
    const names = new Map(
        [...personNames, ...entityNames].map((row) => [
            row.id,
            decryptText(row.name),
        ]),
    );
    const relationLabels = Object.fromEntries(
        state.relations.map((relation) => [
            relation.key,
            decryptText(relation.label),
        ]),
    );
    const sides = ids.map((id) => {
        const record = records.find((record) => record.id === id);
        if (!record)
            throw new AppError(
                ErrorCode.CONFLICT,
                "These records changed. Compare them again.",
                409,
                { reason: "stale_comparison" },
            );
        const key = `${kind === "person" ? "p" : "e"}:${id}`;
        return {
            ...record,
            emails: [
                ...new Set(
                    [
                        record.primaryEmail,
                        ...emails
                            .filter((email) => email.personId === id)
                            .map((email) => decryptText(email.email)),
                    ].filter((email): email is string => Boolean(email)),
                ),
            ],
            aliases: aliases
                .filter(
                    (alias) => alias.recordId === id && alias.kind === "alias",
                )
                .map((alias) => decryptText(alias.text)),
            heardAs: aliases
                .filter(
                    (alias) =>
                        alias.recordId === id && alias.kind === "heard_as",
                )
                .map((alias) => decryptText(alias.text)),
            facts: state.facts
                .filter(
                    (fact) => fact.subjectKey === key || fact.objectKey === key,
                )
                .map((fact) => ({
                    id: fact.id,
                    relationKey: fact.relationKey,
                    direction: fact.subjectKey === key ? "subject" : "object",
                    text:
                        fact.subjectKey === key
                            ? fact.objectLiteral
                                ? decryptText(fact.objectLiteral)
                                : (names.get(
                                      fact.objectPersonId ??
                                          fact.objectEntityId ??
                                          "",
                                  ) ?? "")
                            : (names.get(
                                  fact.subjectPersonId ??
                                      fact.subjectEntityId ??
                                      "",
                              ) ?? ""),
                })),
            appearances: appearances
                .filter((item) => item.personId === id)
                .slice(0, 100)
                .map((item) => ({
                    itemId: item.itemId,
                    title: decryptText(item.title),
                })),
            tasks: tasks
                .filter((task) => task.personId === id)
                .slice(0, 100)
                .map((task) => ({
                    id: task.id,
                    itemId: task.itemId,
                    text: decryptText(task.text),
                })),
        };
    });
    const [first, second] = sides;
    if (!first || !second)
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Duplicate pair not found",
            404,
        );
    return {
        kind,
        left: first,
        right: second,
        survivorId: proposedSurvivor(first, second),
        clashes: state.clashes,
        relationLabels,
        version: state.version,
        itemsLimited:
            appearancePages.some((rows) => rows.length > 100) ||
            taskPages.some((rows) => rows.length > 100),
    };
}

export type DuplicateComparison = Awaited<ReturnType<typeof compareDuplicates>>;

/** Join the compared Organization records through the existing authorized merge operations. */
export async function joinDuplicates(
    actorId: string,
    kind: DuplicateKind,
    survivorId: string,
    loserId: string,
    choices: MergeChoices,
): Promise<void> {
    const scope = await requireDuplicateCurator(actorId);
    await mergeState(db, scope, kind, [survivorId, loserId]);
    const affected = await db.transaction((tx) =>
        scopesNamingInTx(
            tx,
            kind === "person"
                ? { personIds: [survivorId, loserId] }
                : { entityIds: [survivorId, loserId] },
        ),
    );
    if (kind === "person")
        await mergePeople(actorId, survivorId, loserId, choices);
    else await mergeEntities(actorId, survivorId, loserId, choices);
    await replanExports(affected);
}
