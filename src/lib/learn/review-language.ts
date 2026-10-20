import { eq, inArray } from "drizzle-orm";
import type { db } from "@/db";
import { userSettings, users } from "@/db/schema";
import {
    type AppLocale,
    defaultLocale,
    normalizeLocale,
} from "@/lib/i18n/config";
import { promptLocaleForLanguage } from "@/lib/profiles/prompts";
import type { RecordingView } from "@/lib/sharing/view";

const LANGUAGE_NAMES: Record<AppLocale, string> = {
    en: "English",
    "cs-CZ": "Czech",
};

/**
 * Resolve the reviewer's locale: the owner's for a personal item; for the
 * Organization view the Organization account's, else the actor's, else the
 * owner's. A UI locale left on Auto follows the browser, which a background
 * run cannot see, so the same people's default transcription language comes
 * next, then the content's language. English when none is supported.
 */
export async function resolveLearnReviewLocale(
    executor: Pick<typeof db, "select">,
    run: {
        userId: string;
        scopeUserId: string;
        view: RecordingView;
        actorUserId?: string | null;
    },
    contentLanguage?: string | null,
): Promise<AppLocale> {
    const candidates =
        run.view === "org"
            ? [run.scopeUserId, run.actorUserId, run.userId]
            : [run.userId];
    const ids = [
        ...new Set(candidates.filter((id): id is string => Boolean(id))),
    ];
    const rows = await executor
        .select({
            id: users.id,
            uiLocale: users.uiLocale,
            transcriptionLanguage: userSettings.defaultTranscriptionLanguage,
        })
        .from(users)
        .leftJoin(userSettings, eq(userSettings.userId, users.id))
        .where(inArray(users.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const field of ["uiLocale", "transcriptionLanguage"] as const) {
        for (const id of ids) {
            const locale = normalizeLocale(byId.get(id)?.[field]);
            if (locale) return locale;
        }
    }
    return promptLocaleForLanguage(contentLanguage) ?? defaultLocale;
}

/** Language instruction for reviewer-facing prose, separate from source text. */
export function learnReviewLanguageRule(locale?: AppLocale | null): string {
    const language = LANGUAGE_NAMES[locale ?? defaultLocale];
    return `Write all reviewer-facing reasons, explanations and other notes in ${language}; keep source names, quotes, values, correction replacements and relation phrases in the source language, and keep keys and identifiers unchanged. In particular, write speakers[].reason and newRecords[].reason in ${language}, including reasons for unresolved speakers with personId null. These reasons are explanations for the reviewer, not source quotes. The transcript's language and the English task instructions do not determine their language. Before returning JSON, check every reason and translate any explanation that is not in ${language}. On repair, preserve the proposed content but correct the language of reviewer-facing prose as well as the JSON shape.`;
}
