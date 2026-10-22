"use client";

import { Command } from "cmdk";
import { Check } from "lucide-react";
import { useExtracted } from "next-intl";
import { useMemo } from "react";
import {
    type DuplicateRecord,
    scoreDuplicate,
} from "@/lib/knowledge/duplicate-score";

interface MergeTarget {
    id: string;
    name: string;
    email?: string | null;
    scope?: "personal" | "org";
    badge?: string;
    aliases?: string[];
    heardAs?: string[];
    typeKey?: string;
    duplicateScore?: number;
}

function searchKey(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Choose a merge destination with the Almanac's searchable command list. */
export function MergeTargetPicker({
    candidates,
    value,
    onChange,
    source,
}: {
    candidates: readonly MergeTarget[];
    value: string;
    onChange: (id: string) => void;
    source?: {
        id: string;
        name: string;
        email?: string | null;
        kind: "person" | "entity";
        typeKey?: string;
    };
}) {
    const i18n = useExtracted();
    const ranked = useMemo(() => {
        if (!source)
            return candidates.map((candidate) => ({ candidate, score: 0 }));
        const record: DuplicateRecord = {
            ...source,
            primaryEmail: source.email ?? null,
            typeKey: source.typeKey ?? "person",
            emails: [],
            aliases: [],
            heardAs: [],
            evidenceCount: 0,
        };
        return candidates
            .map((candidate, index) => ({
                candidate,
                index,
                score:
                    candidate.duplicateScore ??
                    scoreDuplicate(record, {
                        id: candidate.id,
                        name: candidate.name,
                        kind: source.kind,
                        typeKey: candidate.typeKey ?? record.typeKey,
                        primaryEmail: candidate.email ?? null,
                        emails: [],
                        aliases: candidate.aliases ?? [],
                        heardAs: candidate.heardAs ?? [],
                        evidenceCount: 0,
                    })?.score ??
                    0,
            }))
            .sort((a, b) => {
                if (a.score >= 0.6 || b.score >= 0.6) return b.score - a.score;
                return a.index - b.index;
            });
    }, [candidates, source]);
    return (
        <Command
            label={i18n("Merge target")}
            className="rounded-md border"
            filter={(_value, search, keywords) =>
                searchKey((keywords ?? []).join(" ")).includes(
                    searchKey(search),
                )
                    ? 1
                    : 0
            }
        >
            <Command.Input
                autoFocus
                onValueChange={() => onChange("")}
                aria-label={i18n("Merge target")}
                placeholder={i18n("Search by name or email")}
                className="h-9 w-full border-b bg-transparent px-3 text-sm outline-none"
            />
            <Command.List className="max-h-56 overflow-y-auto p-1">
                <Command.Empty className="px-2 py-3 text-sm text-muted-foreground">
                    {i18n("No matches.")}
                </Command.Empty>
                {ranked.map(({ candidate, score }) => (
                    <Command.Item
                        key={candidate.id}
                        value={candidate.id}
                        keywords={[candidate.name, candidate.email ?? ""]}
                        onSelect={() => onChange(candidate.id)}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm data-[selected=true]:bg-muted"
                    >
                        <span className="min-w-0 flex-1">
                            <span className="block truncate">
                                {candidate.name}
                            </span>
                            {score >= 0.6 && (
                                <span className="block text-xs text-muted-foreground">
                                    {i18n("Likely match")}
                                </span>
                            )}
                            {candidate.email && (
                                <span className="block truncate text-xs text-muted-foreground">
                                    {candidate.email}
                                </span>
                            )}
                        </span>
                        {(candidate.scope || candidate.badge) && (
                            <span
                                className={
                                    candidate.scope === "org" &&
                                    !candidate.badge
                                        ? "shrink-0 rounded-full border border-organization/20 bg-organization/5 px-1.5 py-0.5 text-[10px] leading-none text-organization"
                                        : "shrink-0 rounded-full border border-primary/20 bg-primary/5 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                                }
                            >
                                {candidate.badge ??
                                    (candidate.scope === "org"
                                        ? i18n("Organization")
                                        : i18n("Private"))}
                            </span>
                        )}
                        <Check
                            aria-hidden="true"
                            className={`size-4 shrink-0 text-primary ${value === candidate.id ? "opacity-100" : "opacity-0"}`}
                        />
                        {value === candidate.id && (
                            <span className="sr-only">{i18n("Selected")}</span>
                        )}
                    </Command.Item>
                ))}
            </Command.List>
        </Command>
    );
}
