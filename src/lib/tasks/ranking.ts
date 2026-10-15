/** Number of earlier-task candidates sent to one summary call. */
export const TASK_CANDIDATE_LIMIT = 40;

const CONTENT_CHUNK_WORDS = 256;
const CONTENT_CHUNK_OVERLAP_WORDS = 32;

const STOP_WORDS = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "was",
    "were",
    "will",
    "with",
    "aby",
    "ale",
    "ani",
    "az",
    "bez",
    "by",
    "byl",
    "byla",
    "byli",
    "co",
    "do",
    "ho",
    "i",
    "jak",
    "je",
    "jsem",
    "jsme",
    "jsou",
    "k",
    "ke",
    "na",
    "nebo",
    "od",
    "po",
    "pod",
    "pro",
    "se",
    "si",
    "s",
    "ta",
    "tak",
    "ten",
    "to",
    "u",
    "ve",
    "v",
    "za",
    "ze",
    "z",
]);

export interface TaskRankingCandidate {
    id: string;
    text: string;
    assigneePersonId: string | null;
    statementAt: Date;
    vector?: Float32Array | null;
}

export interface TaskRankingInput<T extends TaskRankingCandidate> {
    itemText: string;
    participantPersonIds: readonly string[];
    candidates: readonly T[];
    itemVectors?: readonly Float32Array[];
}

export interface RankedTaskCandidate<T extends TaskRankingCandidate> {
    candidate: T;
    similarity: number;
    sharedParticipants: number;
    recency: number;
}

export interface TaskEmbeddingRankingResult<T extends TaskRankingCandidate> {
    ranked: RankedTaskCandidate<T>[];
    generatedVectors: Map<string, Float32Array>;
    usedEmbeddings: boolean;
}

function normalizedWords(text: string): Set<string> {
    const folded = text
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLocaleLowerCase("und");
    return new Set(
        (folded.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
            (word) => word.length > 1 && !STOP_WORDS.has(word),
        ),
    );
}

function wordOverlap(left: Set<string>, rightText: string): number {
    const right = normalizedWords(rightText);
    if (left.size === 0 || right.size === 0) return 0;
    let shared = 0;
    for (const word of left) {
        if (right.has(word)) shared++;
    }
    return shared / (left.size + right.size - shared);
}

function cosine(left: Float32Array, right: Float32Array): number {
    if (left.length === 0 || left.length !== right.length) return 0;
    let dot = 0;
    let leftLength = 0;
    let rightLength = 0;
    for (let index = 0; index < left.length; index++) {
        const leftValue = left[index] ?? 0;
        const rightValue = right[index] ?? 0;
        dot += leftValue * rightValue;
        leftLength += leftValue * leftValue;
        rightLength += rightValue * rightValue;
    }
    const divisor = Math.sqrt(leftLength * rightLength);
    return divisor > 0 ? dot / divisor : 0;
}

function vectorSimilarity(
    task: Float32Array,
    content: readonly Float32Array[],
): number {
    let best = Number.NEGATIVE_INFINITY;
    for (const chunk of content) best = Math.max(best, cosine(task, chunk));
    return Number.isFinite(best) ? best : 0;
}

/** Rank task candidates without I/O, exposing every lexicographic score part. */
export function rankTaskCandidates<T extends TaskRankingCandidate>(
    input: TaskRankingInput<T>,
): RankedTaskCandidate<T>[] {
    const participants = new Set(input.participantPersonIds);
    const itemWords = normalizedWords(input.itemText);
    return input.candidates
        .map((candidate, index) => ({
            index,
            candidate,
            similarity:
                candidate.vector && input.itemVectors?.length
                    ? vectorSimilarity(candidate.vector, input.itemVectors)
                    : wordOverlap(itemWords, candidate.text),
            sharedParticipants:
                candidate.assigneePersonId &&
                participants.has(candidate.assigneePersonId)
                    ? 1
                    : 0,
            recency: candidate.statementAt.getTime(),
        }))
        .sort(
            (left, right) =>
                right.similarity - left.similarity ||
                right.sharedParticipants - left.sharedParticipants ||
                right.recency - left.recency ||
                left.index - right.index,
        )
        .map(({ index: _index, ...entry }) => entry);
}

/** Rank and retain the candidates that fit in one summary prompt. */
export function topTaskCandidates<T extends TaskRankingCandidate>(
    input: TaskRankingInput<T>,
    limit = TASK_CANDIDATE_LIMIT,
): RankedTaskCandidate<T>[] {
    return rankTaskCandidates(input).slice(0, limit);
}

/** Split item content into bounded embedding inputs without losing words. */
export function taskContentChunks(text: string): string[] {
    const words = text.trim().split(/\s+/u).filter(Boolean);
    const chunks: string[] = [];
    const step = CONTENT_CHUNK_WORDS - CONTENT_CHUNK_OVERLAP_WORDS;
    for (let start = 0; start < words.length; start += step) {
        chunks.push(words.slice(start, start + CONTENT_CHUNK_WORDS).join(" "));
        if (start + CONTENT_CHUNK_WORDS >= words.length) break;
    }
    return chunks;
}

/** Embed missing task vectors and content chunks, falling back as one ranking. */
export async function rankTaskCandidatesWithEmbeddings<
    T extends TaskRankingCandidate,
>(
    input: TaskRankingInput<T>,
    options: {
        embed?: (texts: readonly string[]) => Promise<readonly Float32Array[]>;
        onEmbeddingFailure?: (error: unknown) => void;
    } = {},
): Promise<TaskEmbeddingRankingResult<T>> {
    if (!options.embed) {
        return {
            ranked: rankTaskCandidates({ ...input, itemVectors: undefined }),
            generatedVectors: new Map(),
            usedEmbeddings: false,
        };
    }
    const contentChunks = taskContentChunks(input.itemText);
    if (contentChunks.length === 0) {
        return {
            ranked: rankTaskCandidates({ ...input, itemVectors: undefined }),
            generatedVectors: new Map(),
            usedEmbeddings: false,
        };
    }

    const missing = input.candidates.filter((candidate) => !candidate.vector);
    try {
        const suppliedContent = input.itemVectors ?? [];
        const texts = [
            ...(suppliedContent.length > 0 ? [] : contentChunks),
            ...missing.map((candidate) => candidate.text),
        ];
        const embedded = texts.length > 0 ? await options.embed(texts) : [];
        if (embedded.length !== texts.length) {
            throw new Error(
                "The embedding response does not match the request",
            );
        }
        const contentCount =
            suppliedContent.length > 0 ? 0 : contentChunks.length;
        const itemVectors =
            suppliedContent.length > 0
                ? suppliedContent
                : embedded.slice(0, contentCount);
        const generatedVectors = new Map<string, Float32Array>();
        missing.forEach((candidate, index) => {
            const vector = embedded[contentCount + index];
            if (!vector) {
                throw new Error("The embedding response omitted a task vector");
            }
            generatedVectors.set(candidate.id, vector);
        });
        const candidates = input.candidates.map((candidate) => ({
            ...candidate,
            vector:
                candidate.vector ?? generatedVectors.get(candidate.id) ?? null,
        }));
        return {
            ranked: rankTaskCandidates({
                ...input,
                candidates,
                itemVectors,
            }) as RankedTaskCandidate<T>[],
            generatedVectors,
            usedEmbeddings: true,
        };
    } catch (error) {
        options.onEmbeddingFailure?.(error);
        return {
            ranked: rankTaskCandidates({
                ...input,
                itemVectors: undefined,
                candidates: input.candidates.map((candidate) => ({
                    ...candidate,
                    vector: null,
                })),
            }) as RankedTaskCandidate<T>[],
            generatedVectors: new Map(),
            usedEmbeddings: false,
        };
    }
}
