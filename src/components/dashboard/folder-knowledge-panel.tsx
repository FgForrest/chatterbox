"use client";

import { ArrowLeft, BookOpen, Users } from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useEffect, useState } from "react";
import { FolderCareFlags } from "@/components/almanac/folder-care-flags";
import { ItemLearnOutcomes } from "@/components/items/item-learn-outcomes";
import {
    onLearnReviewsChanged,
    relearnItem,
} from "@/components/learn/review-events";
import { Button } from "@/components/ui/button";
import { useFolderLabel } from "@/hooks/use-folder-label";
import {
    FOLDER_KNOWLEDGE_PAGE_SIZE,
    type FolderKnowledgeResponse,
    type ItemKnowledgeTab,
} from "@/lib/knowledge/folder-knowledge";
import type { ItemKnowledgeResponse } from "@/lib/knowledge/read-item-knowledge";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";
import { onItemProcessingInvalidated } from "@/lib/pipeline/item-processing-events";
import { type RecordingView, withRecordingView } from "@/lib/sharing/view";
import type { RankedAlmanacTerm } from "@/lib/transcription/almanac-terms";
import { formatSpeakerLabel } from "@/lib/transcription/diarization";
import type { RecordingFolder } from "@/types/folder";

type KnowledgeScope =
    | { kind: "folder"; folder: RecordingFolder }
    | {
          kind: "item";
          itemId: string;
          itemKind: "audio" | "mail";
          title: string;
          view?: RecordingView;
      };

export function FolderKnowledgePanel(props: {
    folder: RecordingFolder;
    onBack: () => void;
    contentRevision?: number;
}) {
    return (
        <KnowledgePanel
            scope={{ kind: "folder", folder: props.folder }}
            onBack={props.onBack}
            contentRevision={props.contentRevision}
        />
    );
}

export function KnowledgePanel({
    scope,
    onBack,
    onReview,
    contentRevision = 0,
}: {
    scope: KnowledgeScope;
    onBack: () => void;
    onReview?: (source?: string) => void;
    contentRevision?: number;
}) {
    const i18n = useExtracted();
    const label = useFolderLabel();
    const formatter = useFormatter();
    const vocabulary = useVocabularyLabels();
    const [tab, setTab] = useState<ItemKnowledgeTab>(
        scope.kind === "item" && scope.itemKind === "audio"
            ? "speakers"
            : "people",
    );
    const [forgetRejected, setForgetRejected] = useState(false);
    const [offset, setOffset] = useState(0);
    const [cache, setCache] = useState<
        Record<string, FolderKnowledgeResponse | ItemKnowledgeResponse>
    >({});
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    const scopeId = scope.kind === "folder" ? scope.folder.id : scope.itemId;
    const endpoint =
        scope.kind === "folder"
            ? `/api/folders/${encodeURIComponent(scopeId)}/knowledge`
            : `/api/items/${encodeURIComponent(scopeId)}/knowledge`;
    const url = withRecordingView(
        `${endpoint}?tab=${tab}&offset=${offset}`,
        scope.kind === "item" ? scope.view : undefined,
    );
    const key = `${url}:${contentRevision}:${retry}`;
    const data = cache[key];
    useEffect(() => {
        if (data) return;
        const controller = new AbortController();
        setError(false);
        void fetch(url, { signal: controller.signal })
            .then(async (response) => {
                if (!response.ok) throw new Error("Knowledge request failed");
                const result = (await response.json()) as
                    | FolderKnowledgeResponse
                    | ItemKnowledgeResponse;
                if (!controller.signal.aborted)
                    setCache((current) => ({ ...current, [key]: result }));
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(true);
            });
        return () => controller.abort();
    }, [data, key, url]);
    const item = data && "item" in data ? data.item : null;
    const itemId = scope.kind === "item" ? scope.itemId : null;
    const learning =
        item?.learn?.status === "queued" || item?.learn?.status === "running";
    useEffect(() => {
        if (!itemId) return;
        const refresh = () => setRetry((value) => value + 1);
        const stopReviews = onLearnReviewsChanged(refresh);
        const stopProcessing = onItemProcessingInvalidated(itemId, refresh);
        const timer = learning ? window.setInterval(refresh, 3_000) : null;
        return () => {
            stopReviews();
            stopProcessing();
            if (timer !== null) window.clearInterval(timer);
        };
    }, [itemId, learning]);
    const tabs = [
        ...(scope.kind === "item" && scope.itemKind === "audio"
            ? [{ id: "speakers" as const, label: i18n("Speakers") }]
            : []),
        { id: "people", label: i18n("People") },
        { id: "things", label: i18n("Things") },
        { id: "corrections", label: i18n("Corrections") },
        { id: "facts", label: i18n("Facts") },
        { id: "models", label: i18n("What the models receive") },
    ] as const;
    const organization = (scope: "personal" | "org") =>
        scope === "org" ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-organization/10 px-2 py-0.5 text-xs text-organization">
                <Users className="size-3" />
                {i18n("Organization")}
            </span>
        ) : null;
    const date = (value: string) =>
        formatter.dateTime(new Date(value), { dateStyle: "medium" });
    const reasons = (term: RankedAlmanacTerm) =>
        [
            term.reason.recorder ? i18n("Recording owner") : null,
            term.reason.folderUses
                ? i18n("{count, number}× in this folder", {
                      count: term.reason.folderUses,
                  })
                : null,
            term.reason.ownerUses
                ? i18n(
                      "Your usage: {count, number}× ({recent, number} recent)",
                      {
                          count: term.reason.ownerUses,
                          recent: term.reason.ownerRecent,
                      },
                  )
                : null,
            term.reason.mishearings
                ? i18n(
                      "{count, plural, one {# mishearing} other {# mishearings}}",
                      {
                          count: term.reason.mishearings,
                      },
                  )
                : null,
        ]
            .filter(Boolean)
            .join(" · ") || i18n("Almanac name order");
    return (
        <section
            aria-label={
                scope.kind === "folder"
                    ? i18n("Folder knowledge")
                    : i18n("Item knowledge")
            }
            className="min-w-0 rounded-lg border bg-card lg:sticky lg:top-20 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto"
        >
            <div className="space-y-2 p-4 pb-2">
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <ArrowLeft className="size-4" />
                    {i18n("Back")}
                </Button>
                <h2 className="flex items-center gap-2 text-base font-semibold">
                    <BookOpen className="size-4" />
                    {scope.kind === "folder"
                        ? i18n("Knowledge of folder {folder}", {
                              folder: label(scope.folder),
                          })
                        : scope.itemKind === "audio"
                          ? i18n("Knowledge of recording {title}", {
                                title: scope.title,
                            })
                          : i18n("Knowledge of message {title}", {
                                title: scope.title,
                            })}
                </h2>
                {item && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <p>
                            {item.learn?.pending
                                ? i18n(
                                      "Learn waits for your review ({count})",
                                      { count: String(item.learn.pending) },
                                  )
                                : item.learn?.status === "ready"
                                  ? `${i18n("Learn")}: ${i18n("Review needed")}`
                                  : item.learn?.status === "finished"
                                    ? item.learn.applied === null
                                        ? i18n("Learn complete {date}", {
                                              date: formatter.dateTime(
                                                  new Date(item.learn.at),
                                                  {
                                                      dateStyle: "short",
                                                      timeStyle: "short",
                                                  },
                                              ),
                                          })
                                        : i18n(
                                              "Learn complete {date}, {count, plural, one {# change applied} other {# changes applied}}",
                                              {
                                                  date: formatter.dateTime(
                                                      new Date(item.learn.at),
                                                      {
                                                          dateStyle: "short",
                                                          timeStyle: "short",
                                                      },
                                                  ),
                                                  count:
                                                      item.learn.applied ?? 0,
                                              },
                                          )
                                    : item.learn?.status === "running" ||
                                        item.learn?.status === "queued"
                                      ? i18n("Learning…")
                                      : item.learn?.status === "failed"
                                        ? i18n("Learn failed")
                                        : item.learn?.status === "cancelled" ||
                                            item.learn?.status === "superseded"
                                          ? i18n("Learn stopped")
                                          : i18n("No Learn run yet")}
                        </p>
                        {item.learn?.status === "finished" &&
                            item.learn.skipped !== null &&
                            item.learn.dismissed !== null && (
                                <p>
                                    {i18n(
                                        "{skipped, number} skipped, {dismissed, number} rejected",
                                        {
                                            skipped: item.learn.skipped,
                                            dismissed: item.learn.dismissed,
                                        },
                                    )}
                                </p>
                            )}
                        {item.learn?.pending && onReview ? (
                            <Button
                                size="sm"
                                onClick={() =>
                                    onReview(item.learn?.source ?? undefined)
                                }
                            >
                                {i18n("Review")}
                            </Button>
                        ) : null}
                    </div>
                )}
                {scope.kind === "item" &&
                    item?.canReview &&
                    item.learn?.status === "finished" && (
                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    relearnItem(scope.itemId, forgetRejected);
                                    onBack();
                                }}
                            >
                                {i18n("Re-learn")}
                            </Button>
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <input
                                    type="checkbox"
                                    checked={forgetRejected}
                                    onChange={(event) =>
                                        setForgetRejected(event.target.checked)
                                    }
                                />
                                {i18n("Propose rejected items again")}
                            </label>
                        </div>
                    )}
                {data && scope.kind === "folder" && (
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "{items, plural, one {# item} other {# items}} including {folders, plural, one {# subfolder} other {# subfolders}}. Parent folders are not counted.",
                            {
                                items: data.itemCount,
                                folders: data.subfolderCount,
                            },
                        )}
                    </p>
                )}
            </div>
            <div
                role="tablist"
                aria-label={
                    scope.kind === "folder"
                        ? i18n("Folder knowledge")
                        : i18n("Item knowledge")
                }
                className="flex flex-wrap gap-1 border-b px-3"
            >
                {tabs.map((entry, index) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        id={`knowledge-tab-${entry.id}`}
                        aria-selected={tab === entry.id}
                        aria-controls="folder-knowledge-content"
                        tabIndex={tab === entry.id ? 0 : -1}
                        className="border-b-2 border-transparent px-2 py-3 text-sm text-muted-foreground aria-selected:border-primary aria-selected:font-semibold aria-selected:text-foreground"
                        onClick={() => {
                            setTab(entry.id);
                            setOffset(0);
                            setError(false);
                        }}
                        onKeyDown={(event) => {
                            const next =
                                event.key === "ArrowRight"
                                    ? (index + 1) % tabs.length
                                    : event.key === "ArrowLeft"
                                      ? (index + tabs.length - 1) % tabs.length
                                      : event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? tabs.length - 1
                                          : null;
                            if (next === null) return;
                            event.preventDefault();
                            setTab(tabs[next].id);
                            setOffset(0);
                            setError(false);
                            document
                                .getElementById(
                                    `knowledge-tab-${tabs[next].id}`,
                                )
                                ?.focus();
                        }}
                    >
                        {entry.label}
                        {item && (
                            <span className="ml-1 text-xs tabular-nums text-muted-foreground">
                                {item.counts[entry.id]}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div
                role="tabpanel"
                id="folder-knowledge-content"
                aria-labelledby={`knowledge-tab-${tab}`}
                className="space-y-4 overflow-x-auto p-4"
            >
                {error ? (
                    <div role="alert">
                        <p>
                            {scope.kind === "folder"
                                ? i18n("Could not load folder knowledge")
                                : i18n("Could not load item knowledge")}
                        </p>
                        <Button
                            variant="outline"
                            onClick={() => setRetry((value) => value + 1)}
                        >
                            {i18n("Try again")}
                        </Button>
                    </div>
                ) : !data ? (
                    <output>{i18n("Loading…")}</output>
                ) : (
                    <>
                        {data.tab !== "models" && (
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "{count, plural, one {# result} other {# results}}",
                                    {
                                        count: data.total,
                                    },
                                )}
                            </p>
                        )}
                        {data.tab === "speakers" && item && (
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr>
                                        <th className="p-2">
                                            {i18n("Speaker")}
                                        </th>
                                        <th className="p-2">
                                            {i18n("Person")}
                                        </th>
                                        <th className="p-2">
                                            {i18n("Source")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {item.speakers.map((speaker) => (
                                        <tr
                                            key={speaker.label}
                                            className="border-b"
                                        >
                                            <td className="p-2">
                                                {formatSpeakerLabel(
                                                    speaker.label,
                                                )}
                                            </td>
                                            <td className="p-2">
                                                {speaker.name ??
                                                    i18n("Unknown")}{" "}
                                                <span className="text-xs text-muted-foreground">
                                                    {speaker.status ===
                                                    "confirmed"
                                                        ? i18n("Confirmed")
                                                        : speaker.status ===
                                                            "suggested"
                                                          ? i18n("Proposed")
                                                          : ""}
                                                </span>
                                            </td>
                                            <td className="p-2">
                                                {speaker.source === "calendar"
                                                    ? i18n("Calendar")
                                                    : speaker.source === "meet"
                                                      ? "Google Meet"
                                                      : speaker.source ===
                                                          "user"
                                                        ? i18n("User")
                                                        : speaker.source
                                                          ? i18n("Learn")
                                                          : ""}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {"records" in data && data.tab !== "speakers" && (
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr>
                                        <th className="p-2">
                                            {data.tab === "people"
                                                ? i18n("Person")
                                                : i18n("Thing")}
                                        </th>
                                        <th className="p-2">
                                            {data.tab === "people"
                                                ? i18n("E-mail")
                                                : i18n("Thing type")}
                                        </th>
                                        <th className="p-2">{i18n("Items")}</th>
                                        <th className="p-2">
                                            {i18n("Last used")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.records.map((record) => (
                                        <tr
                                            key={record.id}
                                            className="border-b"
                                        >
                                            <td className="p-2">
                                                {record.name}
                                                {item?.newRecordIds.includes(
                                                    record.id,
                                                ) && (
                                                    <span className="ml-2 text-xs text-primary">
                                                        {scope.kind ===
                                                            "item" &&
                                                        scope.itemKind ===
                                                            "mail"
                                                            ? i18n(
                                                                  "New from this message",
                                                              )
                                                            : i18n(
                                                                  "New from this recording",
                                                              )}
                                                    </span>
                                                )}
                                                {organization(record.scope)}
                                                <FolderCareFlags
                                                    care={
                                                        "care" in data
                                                            ? data.care
                                                            : undefined
                                                    }
                                                    recordId={record.id}
                                                    onChanged={() => {
                                                        setCache({});
                                                        setRetry(
                                                            (value) =>
                                                                value + 1,
                                                        );
                                                    }}
                                                />
                                            </td>
                                            <td className="p-2 text-muted-foreground">
                                                {data.tab === "people"
                                                    ? record.hasEmail
                                                        ? i18n("e-mail")
                                                        : i18n("no e-mail")
                                                    : vocabulary.entityType(
                                                          record.typeKey,
                                                          record.typeLabel,
                                                      )}
                                            </td>
                                            <td className="p-2 tabular-nums">
                                                {record.itemCount}
                                            </td>
                                            <td className="p-2 text-muted-foreground">
                                                {date(record.lastAt)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {"corrections" in data && (
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr>
                                        <th className="p-2">
                                            {i18n("Heard as")}
                                        </th>
                                        <th className="p-2">
                                            {i18n("Corrects to")}
                                        </th>
                                        <th className="p-2">
                                            {item
                                                ? i18n("In this item")
                                                : i18n("Uses")}
                                        </th>
                                        <th className="p-2">
                                            {i18n("Last used")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.corrections.map((row) => (
                                        <tr key={row.id} className="border-b">
                                            <td className="p-2">{row.heard}</td>
                                            <td className="p-2">
                                                {row.targetName}
                                                {organization(row.scope)}
                                                <FolderCareFlags
                                                    care={
                                                        "care" in data
                                                            ? data.care
                                                            : undefined
                                                    }
                                                    recordId={row.targetId}
                                                    onChanged={() => {
                                                        setCache({});
                                                        setRetry(
                                                            (value) =>
                                                                value + 1,
                                                        );
                                                    }}
                                                />
                                            </td>
                                            <td className="p-2 tabular-nums">
                                                {row.useCount}×
                                            </td>
                                            <td className="p-2 text-muted-foreground">
                                                {date(row.lastAt)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {"facts" in data && (
                            <table className="w-full text-left text-sm">
                                <thead>
                                    <tr>
                                        <th className="p-2">{i18n("Fact")}</th>
                                        <th className="p-2">
                                            {i18n("Evidence")}
                                        </th>
                                        <th className="p-2">{i18n("When")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {data.facts.map((row) => (
                                        <tr key={row.id} className="border-b">
                                            <td className="p-2">
                                                {row.subject} ·{" "}
                                                {vocabulary.relation(
                                                    row.relationKey,
                                                    row.relationLabel,
                                                )}{" "}
                                                · {row.object}
                                                {"newFromItem" in row && (
                                                    <span className="ml-2 text-xs text-muted-foreground">
                                                        {row.newFromItem
                                                            ? i18n("New fact")
                                                            : i18n(
                                                                  "Mentioned again",
                                                              )}
                                                    </span>
                                                )}
                                                {organization(row.scope)}
                                                <FolderCareFlags
                                                    care={
                                                        "care" in data
                                                            ? data.care
                                                            : undefined
                                                    }
                                                    factId={row.factId}
                                                    onChanged={() => {
                                                        setCache({});
                                                        setRetry(
                                                            (value) =>
                                                                value + 1,
                                                        );
                                                    }}
                                                />
                                            </td>
                                            <td className="p-2">
                                                {row.itemTitle}
                                            </td>
                                            <td className="p-2 text-muted-foreground">
                                                {date(row.itemDate)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                        {data.tab !== "models" && data.total === 0 && (
                            <p className="py-6 text-center text-sm text-muted-foreground">
                                {scope.kind === "folder"
                                    ? i18n(
                                          "No knowledge mentioned in this folder yet.",
                                      )
                                    : i18n(
                                          "No knowledge mentioned in this item yet.",
                                      )}
                            </p>
                        )}
                        {data.tab !== "models" &&
                            (offset > 0 || data.nextOffset !== null) && (
                                <div className="flex items-center justify-between">
                                    <Button
                                        variant="outline"
                                        disabled={offset === 0}
                                        onClick={() =>
                                            setOffset((value) =>
                                                Math.max(
                                                    0,
                                                    value -
                                                        FOLDER_KNOWLEDGE_PAGE_SIZE,
                                                ),
                                            )
                                        }
                                    >
                                        {i18n("Previous")}
                                    </Button>
                                    <Button
                                        variant="outline"
                                        disabled={data.nextOffset === null}
                                        onClick={() => {
                                            if (data.nextOffset !== null)
                                                setOffset(data.nextOffset);
                                        }}
                                    >
                                        {i18n("Next")}
                                    </Button>
                                </div>
                            )}
                        {item?.review && data.tab !== "models" && (
                            <ItemLearnOutcomes review={item.review} tab={tab} />
                        )}
                        {data.tab === "models" &&
                            item?.modelContextAvailable === false && (
                                <p className="text-sm text-muted-foreground">
                                    {i18n(
                                        "Received items do not expose the owner's Almanac context.",
                                    )}
                                </p>
                            )}
                        {data.tab === "models" &&
                            item?.modelContextAvailable !== false && (
                                <>
                                    {scope.kind === "folder" ? (
                                        <p className="text-sm text-muted-foreground">
                                            {i18n(
                                                "Preview for a new item owned by you, filed only here, with no transcript mentions yet. Other placements, owner, language and transcript mentions can change the order.",
                                            )}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-muted-foreground">
                                            {i18n(
                                                "Current Almanac context for this item. Later changes can differ from what an earlier run received.",
                                            )}
                                        </p>
                                    )}
                                    {scope.kind === "folder" && (
                                        <p className="text-sm text-muted-foreground">
                                            {data.language
                                                ? i18n(
                                                      "Transcription language from the folder's audio profile: {language}.",
                                                      {
                                                          language:
                                                              data.language,
                                                      },
                                                  )
                                                : i18n(
                                                      "Language is unknown, so mishearings from all languages are included.",
                                                  )}
                                        </p>
                                    )}
                                    {scope.kind === "folder" &&
                                        "folder" in data &&
                                        data.folder.isRoot && (
                                            <p className="rounded-md bg-muted p-3 text-sm">
                                                {i18n(
                                                    "Items filed directly in a root folder get no context from that root folder. Root folders are excluded from ranking; their subfolders can still contribute usage.",
                                                )}
                                            </p>
                                        )}
                                    {(scope.kind === "folder" ||
                                        scope.itemKind === "audio") && (
                                        <>
                                            <div className="space-y-3 rounded-lg border p-3">
                                                <h3 className="font-semibold">
                                                    {i18n("Transcription")}
                                                </h3>
                                                <p className="text-xs text-muted-foreground">
                                                    {i18n(
                                                        "Up to {limit, plural, one {# term} other {# terms}}. The folder only ranks them; it never filters the Almanac.",
                                                        {
                                                            limit: data
                                                                .transcription
                                                                .limit,
                                                        },
                                                    )}
                                                </p>
                                                {data.transcription.terms.map(
                                                    (term, index) => (
                                                        <div
                                                            key={term.text}
                                                            className="flex flex-wrap items-baseline gap-x-3 text-sm"
                                                        >
                                                            <span className="w-7 text-right tabular-nums text-muted-foreground">
                                                                {index + 1}
                                                            </span>
                                                            <span>
                                                                {term.text}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">
                                                                {reasons(term)}
                                                                {term.soundsLike
                                                                    .length
                                                                    ? ` · ${term.soundsLike.join(", ")}`
                                                                    : ""}
                                                            </span>
                                                        </div>
                                                    ),
                                                )}
                                                {data.transcription.sent >
                                                    data.transcription.terms
                                                        .length && (
                                                    <p className="text-xs text-muted-foreground">
                                                        {i18n(
                                                            "… {count, plural, one {# more name, alias or term} other {# more names, aliases and terms}}",
                                                            {
                                                                count:
                                                                    data
                                                                        .transcription
                                                                        .sent -
                                                                    data
                                                                        .transcription
                                                                        .terms
                                                                        .length,
                                                            },
                                                        )}
                                                    </p>
                                                )}
                                                {data.transcription.total >
                                                    data.transcription
                                                        .limit && (
                                                    <p className="border-t-2 border-dashed border-primary pt-2 text-xs font-semibold text-primary">
                                                        {i18n(
                                                            "{limit, number}-term cut line: transcription does not receive terms below this limit.",
                                                            {
                                                                limit: data
                                                                    .transcription
                                                                    .limit,
                                                            },
                                                        )}
                                                    </p>
                                                )}
                                                {data.transcription.belowCut.map(
                                                    (term, index) => (
                                                        <div
                                                            key={term.text}
                                                            className="flex flex-wrap gap-x-3 text-sm text-muted-foreground"
                                                        >
                                                            <span>
                                                                {data
                                                                    .transcription
                                                                    .limit +
                                                                    1 +
                                                                    index}
                                                            </span>
                                                            <span>
                                                                {term.text}
                                                            </span>
                                                            <span className="text-xs">
                                                                {reasons(term)}
                                                            </span>
                                                        </div>
                                                    ),
                                                )}
                                                <p className="text-xs text-muted-foreground">
                                                    {i18n(
                                                        "{sent, number} of {total, number} terms sent",
                                                        {
                                                            sent: data
                                                                .transcription
                                                                .sent,
                                                            total: data
                                                                .transcription
                                                                .total,
                                                        },
                                                    )}
                                                </p>
                                            </div>
                                            <div className="space-y-3 rounded-lg border p-3">
                                                <h3 className="font-semibold">
                                                    {i18n(
                                                        "Transcript correction",
                                                    )}
                                                </h3>
                                                <p className="text-sm">
                                                    {i18n(
                                                        "Names, aliases and mishearings, no facts. Transcript mentions come first, then folder usage. Up to {limit, plural, one {# record} other {# records}}.",
                                                        {
                                                            limit: data
                                                                .correction
                                                                .limit,
                                                        },
                                                    )}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    {i18n(
                                                        "{count, plural, one {# record} other {# records}}; exact preview of the first {preview, plural, one {# record} other {# records}}.",
                                                        {
                                                            count: data
                                                                .correction
                                                                .count,
                                                            preview:
                                                                data.correction
                                                                    .previewCount,
                                                        },
                                                    )}
                                                </p>
                                                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                                                    {data.correction.preview}
                                                </pre>
                                            </div>
                                        </>
                                    )}
                                    <div className="space-y-2 rounded-lg border p-3">
                                        <h3 className="font-semibold">
                                            {i18n("Learn")}
                                        </h3>
                                        <p className="text-sm">
                                            {i18n(
                                                "The model looks knowledge up itself, up to 10 results per lookup from the item's readable Almanac. Folder usage breaks ties.",
                                            )}
                                        </p>
                                    </div>
                                    <div className="space-y-2 rounded-lg border p-3">
                                        <h3 className="font-semibold">
                                            {i18n("Summary")}
                                        </h3>
                                        <p className="text-sm">
                                            {scope.kind === "item" &&
                                            scope.itemKind === "mail"
                                                ? i18n(
                                                      "The model receives the message text, with no Almanac.",
                                                  )
                                                : i18n(
                                                      "The model receives only the corrected transcript, with no Almanac. Speaker names are filled in afterwards.",
                                                  )}
                                        </p>
                                    </div>
                                    <div className="space-y-2 rounded-lg border p-3">
                                        <h3 className="font-semibold">
                                            {i18n("MCP")}
                                        </h3>
                                        <p className="text-sm">
                                            {scope.kind === "item"
                                                ? i18n(
                                                      "MCP reads authorized knowledge. This item does not grant access to other private knowledge.",
                                                  )
                                                : i18n(
                                                      "MCP reads the authorized Organization and private Almanac without a folder filter. This folder has no effect.",
                                                  )}
                                        </p>
                                    </div>
                                </>
                            )}
                    </>
                )}
            </div>
        </section>
    );
}
