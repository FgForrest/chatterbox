import { eq } from "drizzle-orm";
import { db } from "@/db";
import { type AlmanacUsageRow, almanacUsage } from "@/db/queries/almanac-usage";
import { users } from "@/db/schema";
import {
    type KnowledgeView,
    knowledgeView,
} from "@/lib/knowledge/knowledge-loader";
import { findPersonByEmail } from "@/lib/knowledge/people";

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

/**
 * The names a recording's transcription should expect, best first, at
 * most `limit`: the recorder, then the people and things the owner's
 * transcripts named lately, then those named at all, then the ones
 * transcription misheard before, then the rest. Each record gives its
 * name, with the forms it was misheard as in `language` (any language when
 * unknown), and its nicknames.
 */
export function rankAlmanacTerms(input: {
    items: readonly ViewItem[];
    usage: readonly AlmanacUsageRow[];
    recorderId: string | null;
    language: string | null;
    limit?: number;
}): AlmanacTerm[] {
    const limit = input.limit ?? MAX_ALMANAC_TERMS;
    const usage = new Map<string, AlmanacUsageRow>();
    for (const row of input.usage) {
        const id = row.personId ?? row.entityId;
        if (id) usage.set(id, row);
    }
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

    const terms: AlmanacTerm[] = [];
    const byKey = new Map<string, AlmanacTerm>();
    const add = (text: string, soundsLike: string[]) => {
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
        if (terms.length >= limit) return;
        const fresh = {
            text: term,
            soundsLike: [...new Set(heard)].slice(0, MAX_SOUNDS_LIKE),
        };
        byKey.set(key, fresh);
        terms.push(fresh);
    };
    for (const item of ranked) {
        if (terms.length >= limit) break;
        add(
            item.name,
            misheard(item).map((name) => name.text),
        );
        for (const name of item.names) {
            if (name.kind === "alias") add(name.text, []);
        }
    }
    return terms;
}

/**
 * The names a transcription of `ownerUserId`'s recording should expect,
 * from the Almanac its Learn reads: the owner's and the Organization's
 * records, or on the Organization view the Organization's alone.
 */
export async function almanacTermsFor(input: {
    ownerUserId: string;
    shared: boolean;
    language: string | null;
    limit?: number;
}): Promise<AlmanacTerm[]> {
    const view = await knowledgeView({
        kind: "recording",
        ownerUserId: input.ownerUserId,
        shared: input.shared,
    });
    if (view.items.length === 0) return [];
    const [usage, recorderId] = await Promise.all([
        almanacUsage(
            input.ownerUserId,
            new Date(Date.now() - RECENT_DAYS * DAY_MS),
        ),
        input.shared ? null : recorderIdOf(input.ownerUserId),
    ]);
    return rankAlmanacTerms({
        items: view.items,
        usage,
        recorderId,
        language: input.language,
        limit: input.limit,
    });
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
