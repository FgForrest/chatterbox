"use client";

import { ArrowLeft, Building2 } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { KnownFacts, OtherNames } from "@/components/people/known-facts";
import type { PageRelation } from "@/lib/knowledge/fact-page";

export interface EntityDetailProps {
    entity: {
        id: string;
        name: string;
        /** The entity type's label, as the viewer's vocabulary names it. */
        typeLabel: string | null;
        description: string | null;
        /** The viewer's own notes, on an Organization entity. */
        notes: string | null;
        scope: "personal" | "org";
    };
    facts: PageRelation[];
    otherNames: { text: string; kind: "alias" | "heard_as" }[];
}

/**
 * An organization, team, project, product, term, place or document, and
 * what is known about it. Read only for now: editing comes with the review
 * work.
 */
export function EntityDetail({ entity, facts, otherNames }: EntityDetailProps) {
    const i18n = useExtracted();
    return (
        <div className="space-y-8 pb-12">
            <Link
                href="/people"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> {i18n("People")}
            </Link>

            <header className="flex items-start gap-4">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Building2 className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <h1 className="truncate text-2xl font-semibold">
                        {entity.name}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {entity.typeLabel ?? i18n("Unknown type")}
                        {entity.scope === "org" && ` · ${i18n("Organization")}`}
                    </p>
                </div>
            </header>

            <OtherNames names={otherNames} />

            {entity.description && (
                <section className="space-y-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {i18n("Description")}
                    </h2>
                    <p className="whitespace-pre-wrap text-sm">
                        {entity.description}
                    </p>
                </section>
            )}

            {entity.notes && (
                <section className="space-y-2">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {i18n("Your notes")}
                    </h2>
                    <p className="whitespace-pre-wrap text-sm">
                        {entity.notes}
                    </p>
                </section>
            )}

            <section className="space-y-3">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {i18n("What is known")}
                </h2>
                <KnownFacts name={entity.name} relations={facts} />
            </section>
        </div>
    );
}
