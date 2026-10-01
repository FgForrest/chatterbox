"use client";

import { Check, Minus, X } from "lucide-react";
import Link from "next/link";
import { useExtracted } from "next-intl";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

/** An item of a finished run, as the review answer gives it. */
export interface LearnResultItem {
    id: string;
    kind: string;
    preTicked: boolean;
    decision: "accepted" | "rejected" | null;
    outcome?: string | null;
}

/**
 * What finishing the review did with an item. A review finished before
 * outcomes were kept says only whether the item was ticked.
 */
export function outcomeOf(item: LearnResultItem): string {
    if (item.outcome) return item.outcome;
    const decision =
        item.decision ?? (item.preTicked ? "accepted" : "rejected");
    return decision === "accepted" ? "accepted" : "rejected";
}

/**
 * Items a finished review applied; null for a review finished before
 * outcomes were kept, where a ticked item may have been skipped.
 */
export function learnedCount(items: readonly LearnResultItem[]): number | null {
    if (items.some((item) => !item.outcome)) return null;
    return items.filter((item) => item.outcome === "applied").length;
}

/** Why a ticked item was not applied, in the reader's words. */
export function useSkipReason(): (code: string | undefined) => string {
    const i18n = useExtracted();
    return (code) => {
        switch (code) {
            case "nobody_chosen":
                return i18n("nobody was chosen");
            case "answered_since":
                return i18n("someone answered it since");
            case "speaker_not_named":
                return i18n("its speaker is not named yet");
            case "known_elsewhere":
                return i18n("it is known in another scope");
            case "nothing_chosen":
                return i18n("nothing was chosen for it");
            case "already_exists":
                return i18n("it exists already");
            case "changed":
                return i18n("it changed since Learn ran");
            case "record_not_added":
                return i18n("a person or thing it needs was not added");
            default:
                return i18n("it no longer fits");
        }
    };
}

/** Why a run failed, from its error code. */
export function useLearnFailure(): (code: string | null | undefined) => string {
    const i18n = useExtracted();
    return (code) => {
        switch (code) {
            case "AI_PROVIDER_NOT_CONFIGURED":
                return i18n(
                    "Learn needs a chat provider. Add one in Settings → Providers.",
                );
            case "AI_PROVIDER_API_ERROR":
                return i18n(
                    "The provider's answer was not one Learn could use. Try again, or pick another model for Learn in Settings → Providers.",
                );
            default:
                return i18n("Learn stopped on an error. Try again.");
        }
    };
}

/**
 * The last run once it is over, read-only: what its review did with each
 * item, that it found nothing, or why it failed; and Re-learn.
 */
export function LearnResults({
    open,
    onOpenChange,
    status,
    errorCode,
    items,
    known,
    describe,
    onRelearn,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    status: "finished" | "failed";
    errorCode: string | null;
    items: readonly LearnResultItem[];
    /** A run that found nothing: what it had to go on. */
    known?: { people: number; things: number };
    /** An item in a few words, as the review lists it. */
    describe: (item: LearnResultItem) => ReactNode;
    /**
     * Absent where Learn cannot run for this person now. `forget`: what
     * was rejected on the recording may be proposed again.
     */
    onRelearn?: (forget: boolean) => void;
}) {
    const i18n = useExtracted();
    const [forget, setForget] = useState(false);
    const skipReason = useSkipReason();
    const failure = useLearnFailure();

    const sections = [
        { kind: "new_record", title: i18n("New in the Almanac") },
        { kind: "speaker", title: i18n("Speakers") },
        { kind: "correction", title: i18n("Corrections") },
        { kind: "known_fact", title: i18n("Known facts mentioned again") },
        { kind: "fact", title: i18n("New facts") },
        { kind: "relation_phrase", title: i18n("New kind of relation") },
    ];

    const verdict = (item: LearnResultItem) => {
        const outcome = outcomeOf(item);
        if (outcome === "applied") {
            return {
                icon: <Check className="size-4 text-emerald-600" />,
                text: i18n("applied"),
            };
        }
        if (outcome === "accepted") {
            return {
                icon: <Check className="size-4 text-emerald-600" />,
                text: i18n("accepted"),
            };
        }
        if (outcome === "rejected") {
            return {
                icon: <X className="size-4 text-muted-foreground" />,
                text: i18n("rejected"),
            };
        }
        return {
            icon: <Minus className="size-4 text-amber-600" />,
            text: i18n("not applied: {why}", { why: skipReason(outcome) }),
        };
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {status === "failed"
                            ? i18n("Learn failed")
                            : i18n("Learned")}
                    </DialogTitle>
                    <DialogDescription>
                        {status === "failed"
                            ? failure(errorCode)
                            : items.length === 0
                              ? i18n(
                                    "Learn found nothing new in this transcript.",
                                )
                              : i18n(
                                    "What Learn proposed on this transcript, and what your review did with it.",
                                )}
                    </DialogDescription>
                </DialogHeader>

                {status === "finished" && items.length === 0 && known && (
                    <div className="space-y-2 text-sm">
                        <p>
                            {i18n(
                                "Learn names speakers, corrects misheard names and proposes facts about the people and things Riffado already knows. It knows {people, plural, =0 {no people} one {# person} other {# people}} and {things, plural, =0 {no things} one {# thing} other {# things}}.",
                                {
                                    people: known.people,
                                    things: known.things,
                                },
                            )}
                        </p>
                        <Link
                            href="/almanac/things"
                            className="font-medium text-primary hover:underline"
                        >
                            {i18n("Add people and things")}
                        </Link>
                    </div>
                )}

                {status === "finished" &&
                    sections.map((section) => {
                        const inSection = items.filter(
                            (item) => item.kind === section.kind,
                        );
                        if (inSection.length === 0) return null;
                        return (
                            <section key={section.kind} className="space-y-2">
                                <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                                    {section.title}
                                </h3>
                                <ul className="space-y-1.5">
                                    {inSection.map((item) => {
                                        const { icon, text } = verdict(item);
                                        return (
                                            <li
                                                key={item.id}
                                                className="flex items-start gap-2 text-sm"
                                            >
                                                <span className="mt-0.5 shrink-0">
                                                    {icon}
                                                </span>
                                                <span className="min-w-0">
                                                    {describe(item)}{" "}
                                                    <span className="text-xs text-muted-foreground">
                                                        {text}
                                                    </span>
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        );
                    })}

                {onRelearn && (
                    <label className="flex items-start gap-2 text-sm">
                        <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0"
                            checked={forget}
                            onChange={(event) =>
                                setForget(event.target.checked)
                            }
                        />
                        <span>
                            {i18n(
                                "Re-learn: also propose again what I rejected on this recording",
                            )}
                        </span>
                    </label>
                )}

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Close")}
                    </Button>
                    {onRelearn && (
                        <Button onClick={() => onRelearn(forget)}>
                            {i18n("Re-learn")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
