import { inArray } from "drizzle-orm";
import type { db } from "@/db";
import { users } from "@/db/schema";
import {
    type AppLocale,
    defaultLocale,
    normalizeLocale,
} from "@/lib/i18n/config";
import type { RecordingView } from "@/lib/sharing/view";

const LANGUAGE_NAMES: Record<AppLocale, string> = {
    en: "English",
    "cs-CZ": "Czech",
};

/**
 * Resolve the reviewer's UI locale: the owner's for a personal item; for the
 * Organization view the Organization account's, else the actor's, else the
 * owner's. English when none of them has a supported locale.
 */
export async function resolveLearnReviewLocale(
    executor: Pick<typeof db, "select">,
    run: {
        userId: string;
        scopeUserId: string;
        view: RecordingView;
        actorUserId?: string | null;
    },
): Promise<AppLocale> {
    const candidates =
        run.view === "org"
            ? [run.scopeUserId, run.actorUserId, run.userId]
            : [run.userId];
    const ids = [
        ...new Set(candidates.filter((id): id is string => Boolean(id))),
    ];
    const rows = await executor
        .select({ id: users.id, uiLocale: users.uiLocale })
        .from(users)
        .where(inArray(users.id, ids));
    for (const id of ids) {
        const locale = normalizeLocale(
            rows.find((row) => row.id === id)?.uiLocale,
        );
        if (locale) return locale;
    }
    return defaultLocale;
}

/** Language instruction for reviewer-facing prose, separate from source text. */
export function learnReviewLanguageRule(locale?: AppLocale | null): string {
    return `Write all reviewer-facing reasons, explanations and other notes in ${LANGUAGE_NAMES[locale ?? defaultLocale]}; keep source names, quotes, values, correction replacements and relation phrases in the source language, and keep keys and identifiers unchanged.`;
}
