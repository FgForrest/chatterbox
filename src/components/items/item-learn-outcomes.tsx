"use client";

import { useExtracted } from "next-intl";
import { outcomeOf, useSkipReason } from "@/components/learn/learn-results";
import { useSpeakerLabel } from "@/components/people/use-speaker-label";
import type { ItemKnowledgeTab } from "@/lib/knowledge/folder-knowledge";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";
import type { ReviewView } from "@/lib/learn/review";

/** The latest Learn decisions in the knowledge tab they concern. */
export function ItemLearnOutcomes({
    review,
    tab,
}: {
    review: ReviewView;
    tab: ItemKnowledgeTab;
}) {
    const i18n = useExtracted();
    const skipReason = useSkipReason();
    const vocabulary = useVocabularyLabels();
    const speakerLabel = useSpeakerLabel();
    const records = new Map(
        review.items
            .filter((item) => item.kind === "new_record")
            .map((item) => {
                const payload = item.payload as unknown as Record<
                    string,
                    unknown
                >;
                const linked =
                    item.choice && "personId" in item.choice
                        ? item.choice.personId
                        : item.choice && "entityId" in item.choice
                          ? item.choice.entityId
                          : null;
                return [
                    String(payload.ref),
                    linked
                        ? (review.names[linked] ?? String(payload.name))
                        : String(
                              item.choice && "name" in item.choice
                                  ? item.choice.name
                                  : (payload.name ?? "?"),
                          ),
                ];
            }),
    );
    const describe = (value: unknown): string => {
        if (!value || typeof value !== "object") return "?";
        if ("personId" in value)
            return review.names[String(value.personId)] ?? "?";
        if ("entityId" in value)
            return review.names[String(value.entityId)] ?? "?";
        if ("newRef" in value) return records.get(String(value.newRef)) ?? "?";
        if ("literal" in value) return String(value.literal);
        if ("displayName" in value) return String(value.displayName);
        if ("unknown" in value) return i18n("unknown");
        if ("speakerLabel" in value)
            return speakerLabel(String(value.speakerLabel));
        return "?";
    };
    const items = review.items.filter((item) => {
        const payload = item.payload as unknown as Record<string, unknown>;
        return tab === "speakers"
            ? item.kind === "speaker"
            : tab === "corrections"
              ? item.kind === "correction"
              : tab === "facts"
                ? ["fact", "known_fact", "relation_phrase"].includes(item.kind)
                : item.kind === "new_record" &&
                  (tab === "people"
                      ? payload.kind === "person"
                      : payload.kind !== "person");
    });
    if (!items.length) return null;
    return (
        <section
            className="space-y-2 border-t pt-3"
            aria-label={i18n("Learn results")}
        >
            <h3 className="text-sm font-semibold">{i18n("Learn results")}</h3>
            <ul className="space-y-2 text-sm">
                {items.map((item) => {
                    const payload = item.payload as unknown as Record<
                        string,
                        unknown
                    >;
                    const outcome = outcomeOf(item);
                    const result =
                        outcome === "applied"
                            ? i18n("applied")
                            : outcome === "accepted"
                              ? i18n("accepted")
                              : outcome === "rejected"
                                ? i18n("rejected")
                                : i18n("not applied: {why}", {
                                      why: skipReason(outcome),
                                  });
                    let text: string;
                    if (item.kind === "new_record") {
                        const key =
                            payload.kind === "person"
                                ? "person"
                                : String(
                                      item.choice && "typeKey" in item.choice
                                          ? item.choice.typeKey
                                          : payload.typeKey,
                                  );
                        text = `${records.get(String(payload.ref)) ?? "?"} (${vocabulary.entityType(key, review.entityTypes?.find((type) => type.key === key)?.label)})`;
                    } else if (item.kind === "speaker")
                        text = `${speakerLabel(String(payload.label))} → ${describe(item.choice ?? payload)}`;
                    else if (item.kind === "correction")
                        text = `${String(payload.heard)} → ${typeof payload.replacement === "string" ? payload.replacement : describe(payload.target)} (${Array.isArray(payload.anchors) ? payload.anchors.length : 0}×)`;
                    else if (item.kind === "relation_phrase")
                        text = String(payload.phrase);
                    else
                        text = `${describe(payload.subject)} · ${vocabulary.relation(String(payload.relationKey), review.relations[String(payload.relationKey)])} · ${describe(payload.object)}`;
                    return (
                        <li
                            key={item.id}
                            className="flex flex-wrap items-baseline gap-2"
                        >
                            <span>{text}</span>
                            {item.kind === "fact" && (
                                <span className="text-xs text-primary">
                                    {i18n("New fact")}
                                </span>
                            )}
                            {item.kind === "known_fact" && (
                                <span className="text-xs text-muted-foreground">
                                    {i18n("Mentioned again")}
                                </span>
                            )}
                            <span className="text-xs text-muted-foreground">
                                {result}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
