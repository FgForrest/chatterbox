"use client";

import { useExtracted } from "next-intl";
import type { DuplicateSignal } from "@/lib/knowledge/duplicate-score";

/** Explain positive and negative duplicate signals, using amber for contrary evidence. */
export function DuplicateSignals({
    for: positive,
    against,
}: {
    for: DuplicateSignal[];
    against: DuplicateSignal[];
}) {
    const i18n = useExtracted();
    const labels: Record<DuplicateSignal, string> = {
        equal_name: i18n("Same name after folding diacritics"),
        nickname: i18n("Known given-name nickname, same surname"),
        surname_form: i18n("Czech surname form (-ová)"),
        typo: i18n("Names differ by one letter"),
        similar_name: i18n("Similar names"),
        alias: i18n("One name is the other's nickname"),
        heard_as: i18n("One name is the other's heard-as form"),
        email_domain: i18n("Same email domain"),
        legal_form: i18n("Same name without the legal form"),
        different_types: i18n("Same name under two types"),
        both_speakers: i18n(
            "Both confirmed speakers in the same transcription",
        ),
        different_emails: i18n("Different emails at different domains"),
    };
    return (
        <div className="flex flex-wrap gap-1.5">
            {positive.map((signal) => (
                <span
                    key={signal}
                    className="rounded-full border border-emerald-600/30 bg-emerald-600/10 px-2.5 py-0.5 text-xs"
                >
                    {labels[signal]}
                </span>
            ))}
            {against.map((signal) => (
                <span
                    key={signal}
                    className="rounded-full border border-amber-600/40 bg-amber-600/10 px-2.5 py-0.5 text-xs text-amber-800 dark:text-amber-300"
                >
                    {labels[signal]}
                </span>
            ))}
        </div>
    );
}
