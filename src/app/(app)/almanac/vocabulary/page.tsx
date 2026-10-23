import Link from "next/link";
import { getExtracted } from "next-intl/server";
import { VocabularyList } from "@/components/people/vocabulary-list";
import { requireAuth } from "@/lib/auth-server";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { listOwnTypes, vocabularyVisibleTo } from "@/lib/knowledge/vocabulary";
import { getVocabularyLabels } from "@/lib/knowledge/vocabulary-labels-server";
import { getOrgUserId } from "@/lib/org/config";

export const dynamic = "force-dynamic";

/**
 * The viewer's own knowledge types to tend: a member's private ones, the
 * Organization's for its account, where those a share adopted from a
 * member come first until kept, renamed or merged (maintainer, 2026-09-29).
 * Each merges into another of its kind the viewer has, or a core one.
 */
export default async function VocabularyPage({
    searchParams,
}: {
    searchParams?: Promise<{ scope?: string }>;
} = {}) {
    const session = await requireAuth();
    const labels = await getVocabularyLabels();
    const i18n = await getExtracted();
    const userId = session.user.id;
    const canCurate = await userCuratesOrganizationNow(userId);
    const orgUserId = await getOrgUserId();
    const organization =
        canCurate &&
        (userId === orgUserId || (await searchParams)?.scope !== "personal");
    const ownerUserId = organization && orgUserId ? orgUserId : userId;
    const [types, vocabulary] = await Promise.all([
        listOwnTypes(ownerUserId),
        vocabularyVisibleTo(userId),
    ]);
    const ownLayer = organization ? "org" : "private";
    const targets = [...vocabulary.entityTypes, ...vocabulary.relationTypes]
        .filter((type) => type.layer === "core" || type.layer === ownLayer)
        // Entities never become people.
        .filter((type) => !(type.kind === "entity" && type.key === "person"))
        .map((type) => ({
            kind: type.kind,
            key: type.key,
            label:
                type.kind === "entity"
                    ? labels.entityType(type.key, type.label)
                    : labels.relation(type.key, type.label),
            core: type.layer === "core",
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    const entityTypeLabels = Object.fromEntries(
        vocabulary.entityTypes.map((type) => [
            type.key,
            labels.entityType(type.key, type.label),
        ]),
    );

    return (
        <div className="mx-auto max-w-3xl space-y-6">
            {canCurate && userId !== orgUserId && (
                <nav className="flex gap-4 text-sm">
                    <Link
                        href="/almanac/vocabulary"
                        aria-current={organization ? "page" : undefined}
                    >
                        {i18n("Organization vocabulary")}
                    </Link>
                    <Link
                        href="/almanac/vocabulary?scope=personal"
                        aria-current={!organization ? "page" : undefined}
                    >
                        {i18n("Your vocabulary")}
                    </Link>
                </nav>
            )}
            <section className="space-y-2">
                <h1 className="text-xl font-semibold">
                    {organization
                        ? i18n("Organization vocabulary")
                        : i18n("Your vocabulary")}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {organization
                        ? i18n(
                              "The kinds of things and relations the Organization's knowledge uses. Those a share brought from a member come first: keep, rename, merge or delete them.",
                          )
                        : i18n(
                              "The kinds of things and relations only your knowledge uses.",
                          )}
                </p>
            </section>
            <VocabularyList
                types={types}
                targets={targets}
                entityTypeLabels={entityTypeLabels}
                organization={organization}
            />
        </div>
    );
}
