import { eq } from "drizzle-orm";
import { db } from "@/db";
import {
    type AlmanacUsageRow,
    almanacScopeUsage,
    almanacUsage,
} from "@/db/queries/almanac-usage";
import { users } from "@/db/schema";
import {
    type KnowledgeView,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { findPersonByEmail } from "@/lib/knowledge/people";
import {
    almanacUsageById,
    compareScopeUsage,
} from "@/lib/knowledge/scope-ranking";
import { getOrgUserId } from "@/lib/org/config";

/** A name the transcription provider should expect to hear. */
export interface AlmanacTerm {
    /** As it is written. */
    text: string;
    /** How transcription misheard it before, in the recording's language. */
    soundsLike: string[];
}

/** Terms sent with one recording, at most. */
export const MAX_ALMANAC_TERMS = 500;

const RECENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// ElevenLabs takes terms shorter than 50 characters, of at most five
// words, without these characters; Speechmatics drops entries over six
// words. One rule fits both.
const MAX_TERM_CHARS = 49;
const MAX_TERM_WORDS = 5;
const UNSUPPORTED_CHARS = /[<>{}[\]\\`]/g;
const MAX_SOUNDS_LIKE = 10;

type ViewItem = KnowledgeView["items"][number];

/**
 * A name made fit to send, or null when it cannot be: too long, too many
 * words, or nothing left once unsupported characters go.
 */
export function cleanTerm(text: string): string | null {
    const cleaned = text.replace(UNSUPPORTED_CHARS, " ").replace(/\s+/g, " ");
    const trimmed = cleaned.trim();
    if (!trimmed || trimmed.length > MAX_TERM_CHARS) return null;
    if (trimmed.split(" ").length > MAX_TERM_WORDS) return null;
    return trimmed;
}

function baseLanguage(language: string | null | undefined): string | null {
    return language ? (language.toLowerCase().split(/[-_]/)[0] ?? null) : null;
}

export interface AlmanacTermRankingInput {
    items: readonly ViewItem[];
    usage: readonly AlmanacUsageRow[];
    scopeUsage?: readonly AlmanacUsageRow[];
    recorderId: string | null;
    language: string | null;
    limit?: number;
}

export interface RankedAlmanacTerm extends AlmanacTerm {
    reason: {
        recorder: boolean;
        folderUses: number;
        ownerRecent: number;
        ownerUses: number;
        mishearings: number;
    };
}

/**
 * The names a recording's transcription should expect, best first, at
 * most `limit`: the recorder, then names used in the item's folder scope,
 * then the people and things the owner's transcripts named lately, then
 * those named at all, then the ones
 * transcription misheard before, then the rest. Each record gives its
 * name, with the forms it was misheard as in `language` (any language when
 * unknown), and its nicknames.
 */
export function rankAlmanacTermsWithReasons(
    input: AlmanacTermRankingInput,
): RankedAlmanacTerm[] {
    return rankTerms(input, false).terms;
}

/** Rank once, retaining the provider's capped list and a few terms below it. */
export function rankAlmanacTermsWithOverflow(input: AlmanacTermRankingInput) {
    return rankTerms(input, true);
}

function rankTerms(input: AlmanacTermRankingInput, includeOverflow: boolean) {
    const limit = input.limit ?? MAX_ALMANAC_TERMS;
    const usage = almanacUsageById(input.usage);
    const scopeUsage = almanacUsageById(input.scopeUsage ?? []);
    const language = baseLanguage(input.language);
    const misheard = (item: ViewItem) =>
        item.names.filter(
            (name) =>
                name.kind === "heard_as" &&
                (!language || baseLanguage(name.language) === language),
        );
    const ranked = [...input.items].sort((a, b) => {
        const recorder =
            Number(b.id === input.recorderId) -
            Number(a.id === input.recorderId);
        if (recorder) return recorder;
        const scoped = compareScopeUsage(a.id, b.id, scopeUsage);
        if (scoped) return scoped;
        const ua = usage.get(a.id);
        const ub = usage.get(b.id);
        return (
            (ub?.recent ?? 0) - (ua?.recent ?? 0) ||
            (ub?.total ?? 0) - (ua?.total ?? 0) ||
            misheard(b).length - misheard(a).length ||
            (ub?.lastAt.getTime() ?? 0) - (ua?.lastAt.getTime() ?? 0) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id)
        );
    });

    const terms: RankedAlmanacTerm[] = [];
    const byKey = new Map<string, RankedAlmanacTerm>();
    let selected: RankedAlmanacTerm[] | undefined = limit <= 0 ? [] : undefined;
    const add = (text: string, soundsLike: string[], item: ViewItem) => {
        const term = cleanTerm(text);
        if (!term) return;
        const key = term.toLocaleLowerCase();
        const heard = soundsLike
            .map(cleanTerm)
            .filter(
                (form): form is string =>
                    form !== null && form.toLocaleLowerCase() !== key,
            );
        const held = byKey.get(key);
        if (held) {
            for (const form of heard) {
                if (
                    held.soundsLike.length < MAX_SOUNDS_LIKE &&
                    !held.soundsLike.includes(form)
                ) {
                    held.soundsLike.push(form);
                }
            }
            return;
        }
        if (!includeOverflow && terms.length >= limit) return;
        const fresh = {
            text: term,
            reason: {
                recorder: item.id === input.recorderId,
                folderUses: scopeUsage.get(item.id)?.total ?? 0,
                ownerRecent: usage.get(item.id)?.recent ?? 0,
                ownerUses: usage.get(item.id)?.total ?? 0,
                mishearings: misheard(item).length,
            },
            soundsLike: [...new Set(heard)].slice(0, MAX_SOUNDS_LIKE),
        };
        byKey.set(key, fresh);
        terms.push(fresh);
    };
    for (const item of ranked) {
        if (!includeOverflow && terms.length >= limit) break;
        add(
            item.name,
            misheard(item).map((name) => name.text),
            item,
        );
        for (const name of item.names) {
            if (name.kind === "alias") add(name.text, [], item);
        }
        if (
            includeOverflow &&
            selected === undefined &&
            terms.length >= limit
        ) {
            selected = terms.slice(0, limit).map((term) => ({
                ...term,
                soundsLike: [...term.soundsLike],
            }));
        }
    }
    return {
        terms: selected ?? terms,
        total: terms.length,
        belowCut: includeOverflow ? terms.slice(limit, limit + 3) : [],
    };
}

/** Ranked names in the provider's wire format. */
export function rankAlmanacTerms(
    input: AlmanacTermRankingInput,
): AlmanacTerm[] {
    return rankAlmanacTermsWithReasons(input).map(({ text, soundsLike }) => ({
        text,
        soundsLike,
    }));
}

/** Shared ranking inputs for transcription and a prospective folder preview. */
export async function almanacTermRankingInput(input: {
    ownerUserId: string;
    shared: boolean;
    language: string | null;
    itemId?: string;
    scopeFolderIds?: readonly string[];
    limit?: number;
}): Promise<AlmanacTermRankingInput> {
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: input.ownerUserId,
        shared: input.shared,
    });
    const since = new Date(Date.now() - RECENT_DAYS * DAY_MS);
    const [usage, scopeUsage, recorderId] = view.items.length
        ? await Promise.all([
              almanacUsage(input.ownerUserId, since),
              input.scopeFolderIds?.length
                  ? almanacScopeUsage({
                        ownerUserId: input.ownerUserId,
                        orgUserId: await getOrgUserId(),
                        itemId: input.itemId,
                        view: input.shared ? "org" : "private",
                        scopeFolderIds: input.scopeFolderIds,
                        recentSince: since,
                    })
                  : [],
              input.shared ? null : recorderIdOf(input.ownerUserId),
          ])
        : [[], [], null];
    return {
        items: view.items,
        usage,
        scopeUsage,
        recorderId,
        language: input.language,
        limit: input.limit,
    };
}

/** The names a recording's transcription should expect from its readable Almanac. */
export async function almanacTermsFor(
    input: Parameters<typeof almanacTermRankingInput>[0],
): Promise<AlmanacTerm[]> {
    return rankAlmanacTerms(
        await almanacTermRankingInput({
            ...input,
            scopeFolderIds: input.itemId ? input.scopeFolderIds : undefined,
        }),
    );
}

async function recorderIdOf(ownerUserId: string): Promise<string | null> {
    const [owner] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, ownerUserId))
        .limit(1);
    if (!owner?.email) return null;
    const person = await findPersonByEmail(ownerUserId, owner.email);
    return person?.id ?? null;
}
