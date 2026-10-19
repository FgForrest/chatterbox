"use client";

import { Command } from "cmdk";
import {
    BookOpenText,
    Check,
    FileText,
    ListChecks,
    UserRound,
} from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { Row } from "@/components/dashboard/command-palette-parts";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";
import type { AppSearchResults, AppSearchScope } from "@/lib/search/types";

/** Page search hits, with translated vocabulary and server-defined task order. */
export function PaletteSearchResults({
    results,
    scope,
    localRecordingIds,
    onSelect,
}: {
    results: AppSearchResults;
    scope: AppSearchScope;
    localRecordingIds: ReadonlySet<string>;
    onSelect: (href: string) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const labels = useVocabularyLabels();
    const heading = (section: string, group: string) =>
        scope === "all" ? `${section} · ${group}` : group;
    const chatter = results.chatter.filter(
        (hit) => !localRecordingIds.has(hit.id),
    );
    return (
        <>
            {chatter.length > 0 && (
                <Command.Group heading={i18n("Chatter")}>
                    {chatter.map((hit) => (
                        <Command.Item
                            keywords={["server-match"]}
                            key={hit.id}
                            value={`chatter:${hit.id}`}
                            onSelect={() => onSelect(hit.href)}
                        >
                            <Row
                                icon={<FileText className="size-4" />}
                                title={hit.title}
                                subtitle={hit.snippet}
                            />
                        </Command.Item>
                    ))}
                </Command.Group>
            )}
            {(["person", "entity", "glossary"] as const).map((kind) => {
                const hits = results.almanac.filter((hit) => hit.kind === kind);
                const title =
                    kind === "person"
                        ? i18n("People")
                        : kind === "entity"
                          ? i18n("Things")
                          : i18n("Glossary");
                return (
                    hits.length > 0 && (
                        <Command.Group
                            key={kind}
                            heading={heading(i18n("Almanac"), title)}
                        >
                            {hits.map((hit) => (
                                <Command.Item
                                    keywords={["server-match"]}
                                    key={`${kind}:${hit.id}:${hit.heard ?? ""}`}
                                    value={`${kind}:${hit.id}:${hit.heard ?? ""}`}
                                    onSelect={() => onSelect(hit.href)}
                                >
                                    <Row
                                        icon={
                                            kind === "person" ? (
                                                <UserRound className="size-4" />
                                            ) : (
                                                <BookOpenText className="size-4" />
                                            )
                                        }
                                        title={
                                            hit.heard
                                                ? `${hit.heard} → ${hit.name}`
                                                : hit.name
                                        }
                                        subtitle={
                                            hit.heard
                                                ? labels.entityType(
                                                      hit.typeKey,
                                                      hit.typeLabel,
                                                  )
                                                : [
                                                      labels.entityType(
                                                          hit.typeKey,
                                                          hit.typeLabel,
                                                      ),
                                                      hit.description,
                                                  ]
                                                      .filter(Boolean)
                                                      .join(" · ")
                                        }
                                        accessory={
                                            hit.scope === "org"
                                                ? i18n("Organization")
                                                : null
                                        }
                                    />
                                </Command.Item>
                            ))}
                        </Command.Group>
                    )
                );
            })}
            {(["open", "done"] as const).map((status) => {
                const hits = results.tasks.filter(
                    (hit) => hit.status === status,
                );
                return (
                    hits.length > 0 && (
                        <Command.Group
                            key={status}
                            heading={heading(
                                i18n("Tasks"),
                                status === "open"
                                    ? i18n("Open tasks")
                                    : i18n("Done"),
                            )}
                        >
                            {hits.map((hit) => (
                                <Command.Item
                                    keywords={["server-match"]}
                                    key={hit.id}
                                    value={`task:${hit.id}`}
                                    onSelect={() => onSelect(hit.href)}
                                >
                                    <Row
                                        icon={
                                            status === "done" ? (
                                                <Check className="size-4" />
                                            ) : (
                                                <ListChecks className="size-4" />
                                            )
                                        }
                                        title={hit.text}
                                        subtitle={hit.recording.title}
                                        accessory={
                                            hit.dueDate
                                                ? format.dateTime(
                                                      new Date(
                                                          `${hit.dueDate}T00:00:00Z`,
                                                      ),
                                                      {
                                                          day: "numeric",
                                                          month: "short",
                                                          timeZone: "UTC",
                                                      },
                                                  )
                                                : i18n("No due date")
                                        }
                                    />
                                </Command.Item>
                            ))}
                        </Command.Group>
                    )
                );
            })}
        </>
    );
}
