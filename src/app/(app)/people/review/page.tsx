import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { getExtracted } from "next-intl/server";
import { requireAuth } from "@/lib/auth-server";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";
import { listVocabularyProposals } from "@/lib/knowledge/vocabulary";
import { reviewQueue } from "@/lib/learn/pending";
import { isOrgAccount } from "@/lib/org/config";

export const dynamic = "force-dynamic";

/**
 * The Learn reviews waiting for the viewer, newest recording first: the
 * owner's on their own recordings (opened on their page), the organization
 * account's on shared ones (opened from the Organization library). The
 * organization account also reads the phrases members suggested, most
 * frequent first; adopting one is a later phase.
 */
export default async function ReviewQueuePage() {
    const session = await requireAuth();
    const i18n = await getExtracted();
    const organization = await isOrgAccount(session.user.id);
    const rows = isLearnDeploymentAvailable()
        ? await reviewQueue(session.user.id, organization)
        : [];
    const phrases = organization
        ? await listVocabularyProposals(session.user.id)
        : [];

    return (
        <div className="container mx-auto max-w-3xl space-y-8 px-4 py-6">
            <div className="flex items-center justify-between gap-4">
                <Link
                    href="/people"
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                    <ArrowLeft className="size-4" /> {i18n("People")}
                </Link>
                <Link
                    href="/people/vocabulary"
                    className="text-sm text-primary hover:underline"
                >
                    {organization
                        ? i18n("Organization vocabulary")
                        : i18n("Your vocabulary")}
                </Link>
            </div>
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
                                key={row.id}
                                className="flex items-center justify-between gap-4 p-3 text-sm"
                            >
                                <span className="min-w-0 truncate">
                                    {row.filename}
                                </span>
                                {organization ? (
                                    <Link
                                        href="/dashboard"
                                        className="shrink-0 text-primary hover:underline"
                                    >
                                        {i18n("Open the Organization library")}
                                    </Link>
                                ) : (
                                    <Link
                                        href={`/recordings/${row.id}`}
                                        className="shrink-0 text-primary hover:underline"
                                    >
                                        {i18n("Review")}
                                    </Link>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            {organization && (
                <section className="space-y-3">
                    <h2 className="text-lg font-semibold">
                        {i18n("Relations members suggested")}
                    </h2>
                    {phrases.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {i18n("No suggestions yet.")}
                        </p>
                    ) : (
                        <ul className="divide-y rounded-lg border">
                            {phrases.map((phrase) => (
                                <li
                                    key={phrase.id}
                                    className="flex items-center justify-between gap-4 p-3 text-sm"
                                >
                                    <span>{phrase.phrase}</span>
                                    <span className="text-muted-foreground">
                                        {i18n(
                                            "{count, plural, one {# member} other {# members}}",
                                            { count: phrase.count },
                                        )}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            )}
        </div>
    );
}
