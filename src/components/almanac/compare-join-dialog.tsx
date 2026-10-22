"use client";

import Link from "next/link";
import { useExtracted } from "next-intl";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { parseApiError } from "@/lib/api-errors";
import { itemDetailHref } from "@/lib/item-detail";
import type { DuplicateComparison } from "@/lib/knowledge/duplicate-comparison";
import type { DuplicateCandidate } from "@/lib/knowledge/duplicates";
import { useVocabularyLabels } from "@/lib/knowledge/vocabulary-labels";

function conflictMessage(
    body: Awaited<ReturnType<typeof parseApiError>>,
    conflictMessages: Record<string, string>,
    fallback: string,
): string {
    const reason = body.details?.reason;
    return (
        (typeof reason === "string" && conflictMessages[reason]) ||
        body.error ||
        fallback
    );
}

/** Compare both Organization records and choose only the name, survivor and conflicting values. */
export function CompareJoinDialog({
    candidate,
    onClose,
    onMerged,
}: {
    candidate: DuplicateCandidate | null;
    onClose: () => void;
    onMerged: (ids: string[]) => void;
}) {
    const i18n = useExtracted();
    const survivorInputId = useId();
    const compareFailure = i18n("Could not compare these records");
    const staleComparison = i18n("These records changed. Compare them again.");
    const tooManyForms = i18n("Too many names or emails to compare at once");
    const tooManyFacts = i18n("Too many facts to compare at once");
    const missingClashChoice = i18n("Choose which value stays for every clash");
    const chosenFactChanged = i18n("The chosen fact changed");
    const emailConflict = i18n("An email belongs to another person");
    const typeMismatch = i18n("Only entities of one type can be merged");
    const incompatibleFacts = i18n(
        "A fact would not fit the surviving type. Change or erase it first.",
    );
    const nameConflict = i18n("An entity of that type already has that name");
    const conflictMessages = useMemo<Record<string, string>>(
        () => ({
            stale_comparison: staleComparison,
            too_many_forms: tooManyForms,
            too_many_facts: tooManyFacts,
            missing_clash_choice: missingClashChoice,
            chosen_fact_changed: chosenFactChanged,
            email_conflict: emailConflict,
            type_mismatch: typeMismatch,
            incompatible_facts: incompatibleFacts,
            name_conflict: nameConflict,
        }),
        [
            staleComparison,
            tooManyForms,
            tooManyFacts,
            missingClashChoice,
            chosenFactChanged,
            emailConflict,
            typeMismatch,
            incompatibleFacts,
            nameConflict,
        ],
    );
    const labels = useVocabularyLabels();
    const [comparison, setComparison] = useState<DuplicateComparison | null>(
        null,
    );
    const [error, setError] = useState<string | null>(null);
    const [survivor, setSurvivor] = useState("");
    const [nameSource, setNameSource] = useState("");
    const [choices, setChoices] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState(false);
    const [reload, setReload] = useState(0);
    const leftId = candidate?.left.id;
    const rightId = candidate?.right.id;
    const kind = candidate?.left.kind;
    useEffect(() => {
        setComparison(null);
        setError(null);
        setChoices({});
        if (!leftId || !rightId || !kind) return;
        const controller = new AbortController();
        const query = new URLSearchParams({
            kind,
            left: leftId,
            right: rightId,
        });
        void fetch(`/api/knowledge/duplicates/compare?${query}`, {
            signal: controller.signal,
            cache: reload ? "reload" : "no-store",
        })
            .then(async (response) => {
                if (!response.ok) {
                    const body = await parseApiError(response);
                    throw new Error(
                        conflictMessage(body, conflictMessages, compareFailure),
                    );
                }
                const data: DuplicateComparison = await response.json();
                if (controller.signal.aborted) return;
                setComparison(data);
                setSurvivor(data.survivorId);
                setNameSource(data.survivorId);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted)
                    setError(
                        error instanceof Error ? error.message : compareFailure,
                    );
            });
        return () => controller.abort();
    }, [leftId, rightId, kind, reload, compareFailure, conflictMessages]);

    async function join() {
        if (!comparison) return;
        setSaving(true);
        try {
            const response = await fetch("/api/knowledge/duplicates/compare", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    kind: comparison.kind,
                    survivorId: survivor,
                    loserId:
                        survivor === comparison.left.id
                            ? comparison.right.id
                            : comparison.left.id,
                    nameSourceId: nameSource,
                    factChoices: choices,
                    version: comparison.version,
                }),
            });
            if (!response.ok) {
                const error = await parseApiError(response);
                setError(
                    conflictMessage(
                        error,
                        conflictMessages,
                        i18n("Could not merge these records"),
                    ),
                );
                return;
            }
            toast.success(
                i18n(
                    "Joined. Links, speakers, tasks and facts now belong to one record.",
                ),
            );
            onMerged([comparison.left.id, comparison.right.id]);
        } catch {
            setError(i18n("Could not merge these records"));
        } finally {
            setSaving(false);
        }
    }

    const side = comparison ? [comparison.left, comparison.right] : [];
    const selectedName =
        side.find((record) => record.id === nameSource)?.name ?? "";
    const union = (values: readonly string[]) =>
        [...new Set(values.filter(Boolean))].join(", ") || i18n("None");
    const relation = (key: string) =>
        labels.relation(key, comparison?.relationLabels[key]);
    const row = (
        title: string,
        left: ReactNode,
        right: ReactNode,
        result: ReactNode,
        clash = false,
        key?: string,
    ) => (
        <tr key={key}>
            <th
                scope="row"
                className="w-36 border-b px-3 py-2 text-left align-top font-normal text-muted-foreground"
            >
                {title}
            </th>
            {[
                { key: "left", content: left },
                { key: "right", content: right },
                { key: "result", content: result },
            ].map(({ key, content }) => (
                <td
                    key={key}
                    className={`border-b px-3 py-2 align-top ${clash ? "bg-amber-600/10" : key === "result" ? "bg-emerald-600/5" : ""}`}
                >
                    {content}
                </td>
            ))}
        </tr>
    );
    const factText = (fact: DuplicateComparison["left"]["facts"][number]) =>
        `${fact.direction === "object" ? "← " : ""}${relation(fact.relationKey)}: ${fact.text}`;
    const factList = (record: DuplicateComparison["left"]) =>
        record.facts.length ? (
            <ul className="space-y-1">
                {record.facts.map((fact) => (
                    <li key={fact.id}>{factText(fact)}</li>
                ))}
            </ul>
        ) : (
            i18n("None")
        );
    const items = (record: DuplicateComparison["left"]) => (
        <ul className="space-y-1">
            {record.appearances.map((item) => (
                <li key={item.itemId}>
                    <Link
                        className="hover:underline"
                        href={itemDetailHref(item.itemId, { view: "org" })}
                    >
                        {item.title}
                    </Link>
                </li>
            ))}
        </ul>
    );
    const tasks = (record: DuplicateComparison["left"]) => (
        <ul className="space-y-1">
            {record.tasks.map((task) => (
                <li key={task.id}>{task.text}</li>
            ))}
        </ul>
    );
    const missingChoice =
        comparison?.clashes.some((clash) => !choices[clash.relationKey]) ??
        true;

    return (
        <Dialog
            open={candidate !== null}
            onOpenChange={(open) => {
                if (!open && !saving) onClose();
            }}
        >
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Compare before joining")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "Everything that does not clash is kept from both. Choose which name and conflicting values stay.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                {!comparison && !error && <output>{i18n("Loading…")}</output>}
                {error && (
                    <div role="alert" className="space-y-2 text-sm">
                        <p>{error}</p>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => setReload((value) => value + 1)}
                        >
                            {i18n("Compare again")}
                        </Button>
                    </div>
                )}
                {comparison && (
                    <>
                        <label
                            htmlFor={survivorInputId}
                            className="flex flex-col gap-1 text-sm"
                        >
                            <span>{i18n("Record that stays")}</span>
                            <NativeSelect
                                id={survivorInputId}
                                value={survivor}
                                disabled={saving}
                                onChange={(event) =>
                                    setSurvivor(event.target.value)
                                }
                            >
                                {side.map((record, index) => (
                                    <option key={record.id} value={record.id}>
                                        {index === 0
                                            ? i18n("Left record")
                                            : i18n("Right record")}
                                        : {record.name}
                                        {record.primaryEmail
                                            ? ` · ${record.primaryEmail}`
                                            : ""}
                                    </option>
                                ))}
                            </NativeSelect>
                        </label>
                        <p className="text-xs text-muted-foreground">
                            {i18n(
                                "A primary email takes priority, then the record with more evidence.",
                            )}
                        </p>
                        <div className="overflow-x-auto rounded-lg border">
                            <table className="w-full min-w-[760px] text-sm">
                                <thead className="bg-muted">
                                    <tr>
                                        <th scope="col" className="px-3 py-2">
                                            <span className="sr-only">
                                                {i18n("Field")}
                                            </span>
                                        </th>
                                        <th
                                            scope="col"
                                            className="px-3 py-2 text-left"
                                        >
                                            {comparison.left.name}
                                        </th>
                                        <th
                                            scope="col"
                                            className="px-3 py-2 text-left"
                                        >
                                            {comparison.right.name}
                                        </th>
                                        <th
                                            scope="col"
                                            className="px-3 py-2 text-left"
                                        >
                                            {i18n("Result")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {row(
                                        i18n("Name"),
                                        ...(side.map((record) =>
                                            comparison.left.name ===
                                            comparison.right.name ? (
                                                record.name
                                            ) : (
                                                <label
                                                    key={record.id}
                                                    className="flex items-baseline gap-2"
                                                >
                                                    <input
                                                        type="radio"
                                                        name="merge-name"
                                                        value={record.id}
                                                        checked={
                                                            nameSource ===
                                                            record.id
                                                        }
                                                        disabled={saving}
                                                        onChange={() =>
                                                            setNameSource(
                                                                record.id,
                                                            )
                                                        }
                                                    />
                                                    {record.name}
                                                </label>
                                            ),
                                        ) as [ReactNode, ReactNode]),
                                        selectedName,
                                    )}
                                    {comparison.kind === "entity" &&
                                        row(
                                            i18n("Kind of thing"),
                                            labels.entityType(
                                                comparison.left.typeKey,
                                                comparison.left.typeLabel,
                                            ),
                                            labels.entityType(
                                                comparison.right.typeKey,
                                                comparison.right.typeLabel,
                                            ),
                                            labels.entityType(
                                                side.find(
                                                    (record) =>
                                                        record.id === survivor,
                                                )?.typeKey ?? "",
                                                side.find(
                                                    (record) =>
                                                        record.id === survivor,
                                                )?.typeLabel,
                                            ),
                                        )}
                                    {row(
                                        i18n("Email"),
                                        union(comparison.left.emails),
                                        union(comparison.right.emails),
                                        union(
                                            side.flatMap(
                                                (record) => record.emails,
                                            ),
                                        ),
                                    )}
                                    {row(
                                        i18n("Nicknames and heard-as forms"),
                                        union([
                                            ...comparison.left.aliases,
                                            ...comparison.left.heardAs,
                                        ]),
                                        union([
                                            ...comparison.right.aliases,
                                            ...comparison.right.heardAs,
                                        ]),
                                        union(
                                            side
                                                .flatMap((record) => [
                                                    record.name,
                                                    ...record.aliases,
                                                    ...record.heardAs,
                                                ])
                                                .filter(
                                                    (name) =>
                                                        name !== selectedName,
                                                ),
                                        ),
                                    )}
                                    {row(
                                        i18n("Facts"),
                                        factList(comparison.left),
                                        factList(comparison.right),
                                        side.some(
                                            (record) => record.facts.length > 0,
                                        ) ? (
                                            <ul className="space-y-1">
                                                {[
                                                    ...new Set(
                                                        side.flatMap((record) =>
                                                            record.facts
                                                                .filter(
                                                                    (fact) =>
                                                                        !comparison.clashes.some(
                                                                            (
                                                                                clash,
                                                                            ) =>
                                                                                clash.factIds.includes(
                                                                                    fact.id,
                                                                                ),
                                                                        ),
                                                                )
                                                                .map(factText),
                                                        ),
                                                    ),
                                                ].map((text) => (
                                                    <li key={text}>{text}</li>
                                                ))}
                                            </ul>
                                        ) : (
                                            i18n("None")
                                        ),
                                    )}
                                    {comparison.clashes.map((clash) => {
                                        const chosen = side
                                            .flatMap((record) => record.facts)
                                            .find(
                                                (fact) =>
                                                    fact.id ===
                                                        choices[
                                                            clash.relationKey
                                                        ] &&
                                                    fact.direction ===
                                                        "subject",
                                            );
                                        const values = side.map((record) => (
                                            <fieldset
                                                key={record.id}
                                                className="space-y-2"
                                            >
                                                <legend className="sr-only">
                                                    {relation(
                                                        clash.relationKey,
                                                    )}
                                                </legend>
                                                {record.facts
                                                    .filter(
                                                        (fact) =>
                                                            fact.direction ===
                                                                "subject" &&
                                                            clash.factIds.includes(
                                                                fact.id,
                                                            ),
                                                    )
                                                    .map((fact) => (
                                                        <label
                                                            key={fact.id}
                                                            className="flex items-baseline gap-2"
                                                        >
                                                            <input
                                                                type="radio"
                                                                name={`merge-fact-${clash.relationKey}`}
                                                                checked={
                                                                    choices[
                                                                        clash
                                                                            .relationKey
                                                                    ] ===
                                                                    fact.id
                                                                }
                                                                disabled={
                                                                    saving
                                                                }
                                                                onChange={() =>
                                                                    setChoices(
                                                                        (
                                                                            current,
                                                                        ) => ({
                                                                            ...current,
                                                                            [clash.relationKey]:
                                                                                fact.id,
                                                                        }),
                                                                    )
                                                                }
                                                            />
                                                            {fact.text}
                                                        </label>
                                                    ))}
                                            </fieldset>
                                        ));
                                        return row(
                                            relation(clash.relationKey),
                                            values[0],
                                            values[1],
                                            <>
                                                {chosen?.text}
                                                <p className="mt-1 text-xs text-muted-foreground">
                                                    {i18n(
                                                        "One value stays current. The other stays in history with its evidence.",
                                                    )}
                                                </p>
                                            </>,
                                            true,
                                            clash.relationKey,
                                        );
                                    })}
                                </tbody>
                                <tbody>
                                    {row(
                                        i18n("Speaker in items"),
                                        items(comparison.left),
                                        items(comparison.right),
                                        i18n("All speaker links are kept."),
                                    )}
                                    {row(
                                        i18n({
                                            id: "almanacCare_openTasks",
                                            message: "Open tasks",
                                        }),
                                        tasks(comparison.left),
                                        tasks(comparison.right),
                                        i18n(
                                            "All tasks move to the record that stays.",
                                        ),
                                    )}
                                </tbody>
                            </table>
                        </div>
                        {comparison.itemsLimited && (
                            <p className="text-xs text-muted-foreground">
                                {i18n(
                                    "Showing up to {limit, number} shared items and open tasks. All links and tasks are kept when joining.",
                                    { limit: 200 },
                                )}
                            </p>
                        )}
                        <p className="text-sm text-muted-foreground">
                            {i18n(
                                "The other record becomes a redirect. Links, speakers, tasks and facts point to the record that stays.",
                            )}
                        </p>
                    </>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={saving}
                        onClick={onClose}
                    >
                        {i18n("Cancel")}
                    </Button>
                    <Button
                        disabled={
                            saving ||
                            !comparison ||
                            missingChoice ||
                            Boolean(error)
                        }
                        onClick={() => void join()}
                    >
                        {i18n("Merge into “{name}”", { name: selectedName })}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
