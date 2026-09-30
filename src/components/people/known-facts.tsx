"use client";

import { Building2, Play, UserRound } from "lucide-react";
import Link from "next/link";
import { useExtracted, useLocale } from "next-intl";
import { formatDateTime } from "@/lib/format-date";
import type {
    FactSide,
    PageEvidence,
    PageRelation,
} from "@/lib/knowledge/fact-page";

function timestamp(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const pad = (value: number) => value.toString().padStart(2, "0");
    return hours > 0
        ? `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`
        : `${minutes}:${pad(seconds % 60)}`;
}

function recordingHref(evidence: PageEvidence): string {
    return evidence.view === "org"
        ? `/dashboard?recording=${encodeURIComponent(evidence.recordingId)}&view=org`
        : `/recordings/${evidence.recordingId}`;
}

function Side({ side }: { side: FactSide }) {
    if (side.kind === "literal" || !side.id) {
        return <span className="font-medium">{side.text}</span>;
    }
    const href =
        side.kind === "person"
            ? `/people/${side.id}`
            : `/people/entities/${side.id}`;
    const Icon = side.kind === "person" ? UserRound : Building2;
    return (
        <Link
            href={href}
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
        >
            <Icon className="size-3.5 text-muted-foreground" />
            {side.text}
        </Link>
    );
}

/**
 * What is known about a person or an entity, by relation and direction:
 * under "leads", what `name` leads; under "reports to <name>", who reports
 * to them. Each fact with where it was said (▸ opens the recording), how
 * many recordings support it and when it was last said. Only what the
 * viewer may read reaches here (`factsForPage`).
 */
export function KnownFacts({
    name,
    relations,
}: {
    /** The page's person or entity. */
    name: string;
    relations: PageRelation[];
}) {
    const i18n = useExtracted();
    const locale = useLocale();
    const groups = relations.flatMap((relation) =>
        (["subject", "object"] as const).flatMap((direction) => {
            const facts = relation.facts.filter(
                (fact) => fact.direction === direction,
            );
            return facts.length === 0
                ? []
                : [
                      {
                          key: `${relation.key}|${direction}`,
                          heading:
                              direction === "subject"
                                  ? relation.label
                                  : `${relation.label} ${name}`,
                          facts,
                      },
                  ];
        }),
    );

    if (groups.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                {i18n("Nothing is known yet.")}
            </p>
        );
    }

    return (
        <div className="space-y-5">
            {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                    <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {group.heading}
                    </h3>
                    <ul className="space-y-2">
                        {group.facts.map((fact) => {
                            const recordingsCount = new Set(
                                fact.evidence.map((item) => item.recordingId),
                            ).size;
                            const latest = fact.evidence[0];
                            return (
                                <li
                                    key={fact.id}
                                    className="rounded-lg border px-3 py-2 text-sm"
                                >
                                    <p>
                                        <Side side={fact.other} />
                                    </p>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        {fact.scope === "org"
                                            ? i18n("Organization")
                                            : i18n("Only you")}
                                        {" · "}
                                        {fact.origin === "manual" &&
                                        recordingsCount === 0
                                            ? i18n("Entered by hand")
                                            : i18n(
                                                  "Supported by {count, plural, one {# recording} other {# recordings}}",
                                                  { count: recordingsCount },
                                              )}
                                        {latest &&
                                            ` · ${i18n("last on {date}", {
                                                date: formatDateTime(
                                                    latest.recordedAt,
                                                    "absolute",
                                                    locale,
                                                ),
                                            })}`}
                                    </p>
                                    {fact.evidence.length > 0 && (
                                        <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                                            {fact.evidence.map((evidence) => (
                                                <li
                                                    key={`${evidence.recordingId}-${evidence.startMs}`}
                                                >
                                                    <Link
                                                        href={recordingHref(
                                                            evidence,
                                                        )}
                                                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                                    >
                                                        <Play className="size-3" />
                                                        {evidence.title}{" "}
                                                        {timestamp(
                                                            evidence.startMs,
                                                        )}
                                                    </Link>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            ))}
        </div>
    );
}

/** Other names: aliases people gave, and how transcription heard the name. */
export function OtherNames({
    names,
}: {
    names: { text: string; kind: "alias" | "heard_as" }[];
}) {
    const i18n = useExtracted();
    if (names.length === 0) return null;
    const aliases = names.filter((name) => name.kind === "alias");
    const heardAs = names.filter((name) => name.kind === "heard_as");
    return (
        <section className="space-y-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {i18n("Also known as")}
            </h2>
            <p className="text-sm">
                {aliases.map((name) => name.text).join(", ")}
                {heardAs.length > 0 && (
                    <span className="text-muted-foreground">
                        {aliases.length > 0 && " · "}
                        {i18n("heard as {names}", {
                            names: heardAs.map((name) => name.text).join(", "),
                        })}
                    </span>
                )}
            </p>
        </section>
    );
}
