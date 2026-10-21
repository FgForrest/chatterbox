import { and, inArray } from "drizzle-orm";
import Link from "next/link";
import { getExtracted } from "next-intl/server";
import { SuggestedRelations } from "@/components/people/suggested-relations";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import { requireAuth } from "@/lib/auth-server";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { itemDetailHref } from "@/lib/item-detail";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { groupPhrases } from "@/lib/knowledge/phrase-groups";
import {
    listVocabularyProposals,
    vocabularyVisibleTo,
} from "@/lib/knowledge/vocabulary";
import { getVocabularyLabels } from "@/lib/knowledge/vocabulary-labels-server";
import { reviewQueue } from "@/lib/learn/pending";
import { getOrgUserId } from "@/lib/org/config";
import { sharedItemCondition } from "@/lib/sharing/shared";
import { taskViewer } from "@/lib/tasks/access";
import { recordingsAwaitingTaskReview } from "@/lib/tasks/tasks";

export const dynamic = "force-dynamic";

/**
 * The Learn reviews waiting for the viewer, newest recording first: the
 * owner's on their own recordings (opened on their page), the organization
 * account's on shared ones (opened from the Organization library). The
 * organization account also decides the phrases members suggested, most
 * frequent first, alike ones grouped (Phase 6). Below, the recordings whose
 * proposed tasks wait for the viewer's review.
 */
export default async function ReviewQueuePage() {
    const session = await requireAuth();
    const labels = await getVocabularyLabels();
    const i18n = await getExtracted();
    const organization = await userCuratesOrganizationNow(session.user.id);
    const orgUserId = await getOrgUserId();
    const queues = isLearnDeploymentAvailable()
        ? await Promise.all([
              session.user.id !== orgUserId
                  ? reviewQueue(session.user.id, false).then((rows) =>
                        rows.map((row) => ({
                            ...row,
                            view: "private" as const,
                        })),
                    )
                  : [],
              organization && orgUserId
                  ? reviewQueue(orgUserId, true).then((rows) =>
                        rows.map((row) => ({ ...row, view: "org" as const })),
                    )
                  : [],
          ])
        : [];
    const rows = queues
        .flat()
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime());
    const taskRows = await recordingsAwaitingTaskReview(
        await taskViewer({ id: session.user.id, email: session.user.email }),
    );
    const sharedTaskItems = new Set(
        orgUserId && taskRows.length > 0
            ? (
                  await db
                      .select({ id: chatterItems.id })
                      .from(chatterItems)
                      .where(
                          and(
                              inArray(
                                  chatterItems.id,
                                  taskRows.map((row) => row.recordingId),
                              ),
                              sharedItemCondition(orgUserId),
                          ),
                      )
              ).map((row) => row.id)
            : [],
    );
    const phrases = organization
        ? await listVocabularyProposals(session.user.id)
        : [];
    // What a suggestion may become: the Organization's and the core's.
    const vocabulary = organization
        ? await vocabularyVisibleTo(session.user.id, { sharedOnly: true })
        : { entityTypes: [], relationTypes: [] };
    const entityTypes = [
        { key: "person", label: labels.entityType("person") },
        ...vocabulary.entityTypes
            .filter((type) => !type.adoptedAsKey)
            .map((type) => ({
                key: type.key,
                label: labels.entityType(type.key, type.label),
            })),
    ];
    const relationTypes = vocabulary.relationTypes
        .filter((type) => !type.adoptedAsKey)
        .map((type) => ({
            key: type.key,
            label: labels.relation(type.key, type.label),
        }));

    return (
        <div className="mx-auto max-w-3xl space-y-8">
            <section className="space-y-3">
                <h1 className="text-xl font-semibold">
                    {i18n("Waiting for review")}
                </h1>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {i18n("Nothing waits for your review.")}
                    </p>
                ) : (
                    <ul className="divide-y rounded-lg border">
                        {rows.map((row) => (
                            <li
                                key={`${row.id}:${row.view}`}
                                className="flex items-center justify-between gap-4 p-3 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.filename}
                                </span>
                                <Link
                                    href={itemDetailHref(row.id, {
                                        view: row.view,
                                    })}
                                    className="shrink-0 text-primary hover:underline"
                                >
                                    {row.view === "org"
                                        ? i18n("Open the Organization library")
                                        : i18n("Review")}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {taskRows.length > 0 && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold">
                        {i18n("Proposed tasks")}
                    </h2>
                    <ul className="divide-y rounded-lg border">
                        {taskRows.map((row) => (
                            <li
                                key={row.recordingId}
                                className="flex items-center justify-between gap-4 p-3 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.title}
                                </span>
                                <span className="flex shrink-0 items-center gap-4">
                                    <span className="text-muted-foreground">
                                        {i18n(
                                            "{count, plural, one {# task} other {# tasks}}",
                                            { count: row.proposals },
                                        )}
                                    </span>
                                    <Link
                                        href={itemDetailHref(row.recordingId, {
                                            view: sharedTaskItems.has(
                                                row.recordingId,
                                            )
                                                ? "org"
                                                : "private",
                                        })}
                                        className="text-primary hover:underline"
                                    >
                                        {sharedTaskItems.has(row.recordingId)
                                            ? i18n(
                                                  "Open the Organization library",
                                              )
                                            : i18n("Review")}
                                    </Link>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {organization && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold">
                        {i18n("Relations members suggested")}
                    </h2>
                    <SuggestedRelations
                        phrases={phrases}
                        groups={groupPhrases(phrases)}
                        entityTypes={entityTypes}
                        relationTypes={relationTypes}
                    />
                </section>
            )}
        </div>
    );
}
