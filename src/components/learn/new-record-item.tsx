"use client";

import { useExtracted } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
    type PickedRecord,
    RecordPicker,
} from "@/components/almanac/record-picker";
import { LearnEvidence, LearnReviewRow } from "@/components/learn/review-parts";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

/** A new record's payload, as the review shows it. */
export interface NewRecordView {
    ref: string;
    kind: "person" | "entity";
    typeKey: string | null;
    name: string;
    evidenceMs: number[];
    reason: string;
    speakerLabel?: string;
    onlyFirstName?: boolean;
    /** A known record whose name is close: perhaps this one, misheard. */
    maybe?: { personId: string } | { entityId: string };
}

/** What a reviewer chose for a new record, as the review keeps it. */
export type NewRecordChoice =
    | { name: string; typeKey: string | null }
    | { personId: string }
    | { entityId: string };

/**
 * The record the Almanac has that a new one is (a reviewer's choice), or
 * null: the id it links to.
 */
export function linkedRecordId(
    choice: Record<string, unknown> | null,
): string | null {
    if (typeof choice?.personId === "string") return choice.personId;
    if (typeof choice?.entityId === "string") return choice.entityId;
    return null;
}

function maybeId(target: { personId: string } | { entityId: string }) {
    return "personId" in target ? target.personId : target.entityId;
}

/** A new record's name and type, as the reviewer left them. */
export function newRecordAs(
    payload: NewRecordView,
    choice: Record<string, unknown> | null,
): { name: string; typeKey: string | null } {
    let typeKey = payload.typeKey;
    if (payload.kind === "person") {
        typeKey = null;
    } else if (typeof choice?.typeKey === "string") {
        typeKey = choice.typeKey;
    }
    return {
        name: typeof choice?.name === "string" ? choice.name : payload.name,
        typeKey,
    };
}

/**
 * One person or thing Learn proposes to add: tick it to add it, with the
 * name (and a thing's type) as the reviewer corrects them, or say which
 * record the Almanac already has it is.
 */
export function NewRecordItem({
    payload,
    choice,
    ticked,
    rejected,
    disabled,
    names,
    entityTypes,
    seek,
    evidence,
    quote,
    onDecide,
    onLinked,
}: {
    payload: NewRecordView;
    choice: Record<string, unknown> | null;
    ticked: boolean;
    /**
     * Rejected outright: not proposed again on any recording (one merely
     * left unticked is not proposed again on this one).
     */
    rejected: boolean;
    disabled: boolean;
    /** Names of the records choices link to, by id. */
    names: Record<string, string>;
    /** The types a new thing may take. */
    entityTypes: { key: string; label: string }[];
    seek: (ms: number) => ReactNode;
    evidence?: ReactNode;
    quote?: ReactNode;
    onDecide: (
        decision: "accepted" | "rejected" | null,
        choice: NewRecordChoice | null,
    ) => Promise<void>;
    /** A record the Almanac has was chosen: its name is to be loaded. */
    onLinked: (choice: NewRecordChoice) => Promise<void>;
}) {
    const i18n = useExtracted();
    const current = newRecordAs(payload, choice);
    const [name, setName] = useState(current.name);
    const [typeKey, setTypeKey] = useState(current.typeKey);
    useEffect(() => setTypeKey(current.typeKey), [current.typeKey]);
    const [picking, setPicking] = useState(false);
    const linked = linkedRecordId(choice);
    const typeLabel = (key: string | null) =>
        entityTypes.find((type) => type.key === key)?.label ?? key ?? "";

    const keep = (next: { name: string; typeKey: string | null }) =>
        onDecide("accepted", next);

    const pick = (record: PickedRecord) => {
        setPicking(false);
        void onLinked(
            record.kind === "person"
                ? { personId: record.id }
                : { entityId: record.id },
        );
    };

    const knownLabel =
        payload.kind === "person"
            ? i18n("It is someone known…")
            : i18n("It is something known…");
    const toggleRejected = () =>
        void onDecide(
            rejected ? null : "rejected",
            (choice as NewRecordChoice | null) ?? null,
        );

    return (
        <LearnReviewRow
            kind="new_record"
            checked={ticked && !rejected}
            disabled={disabled || rejected}
            checkboxLabel={i18n("Add {name} to the Almanac", {
                name: current.name,
            })}
            onCheckedChange={(checked) =>
                void onDecide(
                    checked ? "accepted" : null,
                    (choice as NewRecordChoice | null) ?? null,
                )
            }
        >
            <div className="space-y-1">
                {linked ? (
                    <div className="flex flex-wrap items-center gap-2 py-1">
                        <span>
                            {i18n("{name} is {known}, in the Almanac", {
                                name: payload.name,
                                known: names[linked] ?? "?",
                            })}
                        </span>
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            disabled={disabled}
                            onClick={() =>
                                void keep({
                                    name: payload.name,
                                    typeKey: payload.typeKey,
                                })
                            }
                        >
                            {i18n("Add as new instead")}
                        </Button>
                    </div>
                ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @[560px]/learn:grid-cols-[minmax(0,1fr)_minmax(6rem,10rem)_auto]">
                        <Input
                            className="col-span-2 h-8 w-full min-w-0 @[560px]/learn:col-span-1"
                            value={name}
                            maxLength={200}
                            disabled={disabled || rejected}
                            aria-label={i18n("Name")}
                            onChange={(event) => setName(event.target.value)}
                            onBlur={() => {
                                const trimmed = name.trim();
                                if (!trimmed) {
                                    setName(current.name);
                                    return;
                                }
                                if (trimmed !== current.name) {
                                    void keep({ name: trimmed, typeKey });
                                }
                            }}
                        />
                        {payload.kind === "entity" ? (
                            <NativeSelect
                                className="h-8 w-full min-w-0"
                                aria-label={i18n("Kind of thing")}
                                value={typeKey ?? ""}
                                disabled={disabled || rejected}
                                onChange={(event) => {
                                    setTypeKey(event.target.value);
                                    void keep({
                                        name: name.trim() || current.name,
                                        typeKey: event.target.value,
                                    });
                                }}
                            >
                                {entityTypes.map((type) => (
                                    <option key={type.key} value={type.key}>
                                        {type.label}
                                    </option>
                                ))}
                            </NativeSelect>
                        ) : (
                            <span className="px-3 text-xs text-muted-foreground">
                                {i18n("Person")}
                            </span>
                        )}
                        <div className="hidden items-center justify-end gap-1 @[560px]/learn:flex">
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground"
                                disabled={disabled}
                                onClick={() => setPicking(true)}
                            >
                                {knownLabel}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary"
                                aria-pressed={rejected}
                                disabled={disabled}
                                onClick={toggleRejected}
                            >
                                {i18n("Never propose it")}
                            </Button>
                        </div>
                        <div className="justify-self-end @[560px]/learn:hidden">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="h-8 w-8 p-0"
                                        aria-label={i18n("More options")}
                                        disabled={disabled}
                                    >
                                        <span aria-hidden="true">⋯</span>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem
                                        disabled={disabled}
                                        onSelect={() => setPicking(true)}
                                    >
                                        {knownLabel}
                                    </DropdownMenuItem>
                                    <DropdownMenuCheckboxItem
                                        disabled={disabled}
                                        checked={rejected}
                                        onCheckedChange={toggleRejected}
                                    >
                                        {i18n("Never propose it")}
                                    </DropdownMenuCheckboxItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                )}
                {payload.maybe && !linked && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
                        {i18n("Maybe it is {known}, misheard?", {
                            known: names[maybeId(payload.maybe)] ?? "?",
                        })}
                        <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-xs"
                            disabled={disabled}
                            onClick={() =>
                                payload.maybe && void onLinked(payload.maybe)
                            }
                        >
                            {i18n("Yes, it is {known}", {
                                known: names[maybeId(payload.maybe)] ?? "?",
                            })}
                        </Button>
                    </div>
                )}
                {payload.onlyFirstName &&
                    payload.kind === "person" &&
                    !linked && (
                        <div className="text-xs text-amber-700 dark:text-amber-400">
                            {i18n("Only a first name: add the surname.")}
                        </div>
                    )}
                {evidence ?? (
                    <LearnEvidence quote={quote}>
                        <div className="text-xs text-muted-foreground">
                            {linked && (
                                <>
                                    {payload.kind === "person"
                                        ? i18n("Person")
                                        : typeLabel(current.typeKey)}
                                    {" · "}
                                </>
                            )}
                            {payload.reason}
                            {payload.speakerLabel &&
                                ` · ${i18n("speaks as {label}", { label: payload.speakerLabel })}`}{" "}
                            {payload.evidenceMs.map((ms) => (
                                <span key={ms} className="mr-1">
                                    {seek(ms)}
                                </span>
                            ))}
                        </div>
                    </LearnEvidence>
                )}
            </div>
            <Dialog open={picking} onOpenChange={setPicking}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>
                            {i18n("Which record is {name}?", {
                                name: payload.name,
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {i18n(
                                "What refers to it is then written on that record, and nothing new is added.",
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <RecordPicker
                        kind={payload.kind}
                        typeLabels={Object.fromEntries(
                            entityTypes.map((type) => [type.key, type.label]),
                        )}
                        onPick={pick}
                    />
                </DialogContent>
            </Dialog>
        </LearnReviewRow>
    );
}
