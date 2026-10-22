import {
    boundedLevenshtein,
    NameIndex,
    normalizeName,
    trigramSimilarity,
} from "@/lib/knowledge/name-match";

export type DuplicateKind = "person" | "entity";
export type DuplicateSignal =
    | "equal_name"
    | "nickname"
    | "surname_form"
    | "typo"
    | "similar_name"
    | "alias"
    | "heard_as"
    | "email_domain"
    | "legal_form"
    | "different_types"
    | "both_speakers"
    | "different_emails";

export interface DuplicateRecord {
    id: string;
    kind: DuplicateKind;
    name: string;
    typeKey: string;
    typeLabel?: string;
    primaryEmail: string | null;
    emails: string[];
    aliases: string[];
    heardAs: string[];
    evidenceCount: number;
}

export interface DuplicateScore {
    score: number;
    confidence: "high" | "medium" | "low";
    for: DuplicateSignal[];
    against: DuplicateSignal[];
}

const NICKNAMES = [
    ["ondrej", "ondra"],
    ["jan", "honza", "honzik"],
    ["josef", "pepa"],
    ["jakub", "kuba"],
    ["vaclav", "vasek"],
    ["frantisek", "franta"],
    ["jiri", "jirka"],
    ["alexander", "alex", "sasha"],
    ["robert", "rob", "bob", "bobby"],
    ["william", "will", "bill", "billy"],
    ["richard", "rick", "dick"],
    ["michael", "mike", "mikey"],
    ["elizabeth", "liz", "beth", "betty"],
    ["katherine", "catherine", "kate", "kathy"],
];
const GIVEN_NAMES = new Map(
    NICKNAMES.flatMap(([canonical = "", ...forms]) =>
        [canonical, ...forms].map((form) => [form, canonical] as const),
    ),
);

function personForm(name: string): string {
    const words = normalizeName(name).split(" ");
    words[0] = GIVEN_NAMES.get(words[0] ?? "") ?? words[0] ?? "";
    const last = words.length - 1;
    if (last > 0 && (words[last]?.length ?? 0) > 4) {
        words[last] = (words[last] ?? "").replace(/ova$|a$/, "");
    }
    return words.join(" ");
}

function legalName(name: string): string {
    return normalizeName(name)
        .replace(
            /\b(spol s r o|s r o|a s|ltd|limited|inc|incorporated|gmbh|llc|corp|corporation)\b/g,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
}

function emailDomains(record: DuplicateRecord): Set<string> {
    return new Set(
        [record.primaryEmail, ...record.emails].flatMap((email) => {
            const domain = email?.trim().toLowerCase().split("@")[1];
            return domain ? [domain] : [];
        }),
    );
}

function prepareRecord(record: DuplicateRecord) {
    const name = normalizeName(record.name);
    return {
        record,
        name,
        canonical:
            record.kind === "person" ? personForm(name) : legalName(name),
        digits: (name.match(/\d+/g) ?? []).join(":"),
        aliases: new Set(record.aliases.map(normalizeName)),
        heardAs: new Set(record.heardAs.map(normalizeName)),
        domains: emailDomains(record),
    };
}

/** Score two decrypted records; negative evidence never hides the reason to compare. */
export function scoreDuplicate(
    left: DuplicateRecord,
    right: DuplicateRecord,
    bothSpeakers = false,
): DuplicateScore | null {
    return scorePrepared(
        prepareRecord(left),
        prepareRecord(right),
        bothSpeakers,
    );
}

function scorePrepared(
    leftPrepared: ReturnType<typeof prepareRecord>,
    rightPrepared: ReturnType<typeof prepareRecord>,
    bothSpeakers = false,
): DuplicateScore | null {
    const { record: left, name: a } = leftPrepared;
    const { record: right, name: b } = rightPrepared;
    if (left.kind !== right.kind || left.id === right.id || !a || !b)
        return null;
    const positive: DuplicateSignal[] = [];
    const against: DuplicateSignal[] = [];
    let score = 0;
    const add = (signal: DuplicateSignal, weight: number) => {
        positive.push(signal);
        score = Math.max(score, weight);
    };
    if (a === b) add("equal_name", 0.92);
    if (
        left.kind === "person" &&
        a !== b &&
        leftPrepared.canonical === rightPrepared.canonical
    ) {
        const aw = a.split(" ");
        const bw = b.split(" ");
        if (aw[0] !== bw[0]) add("nickname", 0.84);
        if (aw.at(-1) !== bw.at(-1)) add("surname_form", 0.76);
    }
    if (left.kind === "entity") {
        const legalA = leftPrepared.canonical;
        if (
            left.typeKey === right.typeKey &&
            legalA &&
            legalA === rightPrepared.canonical &&
            a !== b
        ) {
            add("legal_form", 0.92);
        }
        if (a === b && left.typeKey !== right.typeKey)
            add("different_types", 0.92);
    }
    for (const [record, name] of [
        [leftPrepared, b],
        [rightPrepared, a],
    ] as const) {
        if (record.heardAs.has(name)) add("heard_as", 0.86);
        if (record.aliases.has(name)) add("alias", 0.86);
    }
    if (
        a !== b &&
        (left.kind !== "entity" || leftPrepared.digits === rightPrepared.digits)
    ) {
        if (
            Math.min(a.length, b.length) >= 4 &&
            boundedLevenshtein(a, b, 1) === 1
        ) {
            add("typo", 0.68);
        } else if (trigramSimilarity(a, b) >= 0.6) {
            add("similar_name", 0.52);
        }
    }
    const leftDomains = leftPrepared.domains;
    const rightDomains = rightPrepared.domains;
    const sharedDomain = [...leftDomains].some((domain) =>
        rightDomains.has(domain),
    );
    if (sharedDomain) {
        positive.push("email_domain");
        score += 0.04;
    } else if (leftDomains.size && rightDomains.size) {
        against.push("different_emails");
        score -= 0.28;
    }
    if (bothSpeakers) {
        against.push("both_speakers");
        score -= 0.38;
    }
    if (!positive.some((signal) => signal !== "email_domain")) return null;
    score = Math.max(0.05, Math.min(1, score));
    return {
        score,
        confidence: score >= 0.82 ? "high" : score >= 0.6 ? "medium" : "low",
        for: positive,
        against,
    };
}

/** Index the same forms the scorer understands, including nicknames and legal suffixes. */
export function duplicateNameIndex(
    records: readonly DuplicateRecord[],
): NameIndex {
    return new NameIndex(
        records.map((record) => ({
            id: record.id,
            names: duplicateNameForms(record),
        })),
        true,
    );
}

/** Bounded name forms for retrieving candidates from the existing NameIndex. */
export function duplicateNameForms(record: DuplicateRecord): string[] {
    return [
        ...new Set([
            record.name,
            record.kind === "person"
                ? personForm(record.name)
                : legalName(record.name),
            ...record.aliases.slice(0, 8),
            ...record.heardAs.slice(0, 8),
        ]),
    ].filter(Boolean);
}

/** Prefer a primary e-mail, then evidence, with a stable id tie-break. */
export function proposedSurvivor(
    left: DuplicateRecord,
    right: DuplicateRecord,
): string {
    return (
        [left, right].sort(
            (a, b) =>
                Number(Boolean(b.primaryEmail)) -
                    Number(Boolean(a.primaryEmail)) ||
                b.evidenceCount - a.evidenceCount ||
                a.id.localeCompare(b.id),
        )[0]?.id ?? left.id
    );
}

export const MAX_DUPLICATE_NEIGHBORS = 40;

/** Retrieve and score bounded neighbours, yielding between batches so other requests can run. */
export async function rankDuplicateRecords(
    records: readonly DuplicateRecord[],
    sourceId?: string,
): Promise<{ candidates: ScoredDuplicatePair[]; limited: boolean }> {
    const byId = new Map(records.map((record) => [record.id, record]));
    const index = duplicateNameIndex(records);
    const prepared = new Map(
        records.map((record) => [record, prepareRecord(record)]),
    );
    const pairs = new Map<string, ScoredDuplicatePair>();
    let limited = false;
    let processed = 0;
    for (const record of sourceId
        ? records.filter((record) => record.id === sourceId)
        : records) {
        const matches = new Map<string, number>();
        const forms = duplicateNameForms(record);
        for (const form of sourceId ? forms : forms.slice(0, 2)) {
            for (const match of index.match(form)) {
                if (match.id !== record.id)
                    matches.set(
                        match.id,
                        Math.max(match.score, matches.get(match.id) ?? 0),
                    );
            }
        }
        const nearest = [...matches].sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        );
        if (nearest.length > MAX_DUPLICATE_NEIGHBORS) limited = true;
        for (const [id] of nearest.slice(0, MAX_DUPLICATE_NEIGHBORS)) {
            const key = `${record.kind}:${[record.id, id].sort().join(":")}`;
            if (pairs.has(key)) continue;
            const other = byId.get(id);
            if (!other) continue;
            const [left, right] =
                record.id < id ? [record, other] : [other, record];
            const leftPrepared = prepared.get(left);
            const rightPrepared = prepared.get(right);
            if (!leftPrepared || !rightPrepared) continue;
            const score = scorePrepared(leftPrepared, rightPrepared);
            if (score)
                pairs.set(key, {
                    key,
                    left,
                    right,
                    ...score,
                    survivorId: proposedSurvivor(left, right),
                });
        }
        if (++processed % 25 === 0)
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return { candidates: [...pairs.values()], limited };
}

export interface ScoredDuplicatePair extends DuplicateScore {
    key: string;
    left: DuplicateRecord;
    right: DuplicateRecord;
    survivorId: string;
}
