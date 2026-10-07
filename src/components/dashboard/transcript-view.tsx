"use client";

import { Check, Play } from "lucide-react";
import { useExtracted } from "next-intl";
import {
    Fragment,
    type MouseEvent,
    type RefObject,
    useMemo,
    useRef,
} from "react";
import { TranscriptPlayMarker } from "@/components/dashboard/transcript-play-marker";
import { CorrectedText } from "@/components/learn/corrected-text";
import {
    type LearnCorrectionMark,
    type LearnMarks,
    type TurnPiece,
    turnPieces,
} from "@/components/learn/learn-marks";
import { MarkedText } from "@/components/learn/marked-text";
import {
    type SpeakerAccent,
    speakerAccent,
} from "@/components/people/speaker-accents";
import {
    type TranscriptPlayback,
    useTranscriptFollow,
} from "@/hooks/use-transcript-follow";
import { isUntimed } from "@/lib/knowledge/correction-anchors";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import type { SpeakerAttributions } from "@/lib/knowledge/speaker-references";
import type { OverlayCorrection } from "@/lib/learn/render";
import {
    formatClock,
    paragraphsOf,
    sentenceStarts,
    type TranscriptParagraph,
    type TranscriptTopic,
} from "@/lib/topics/timeline";
import {
    formatSpeakerLabel,
    mayBeDiarized,
    parseSpeakerTurns,
    speakerOrder,
} from "@/lib/transcription/diarization";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export interface TranscriptViewProps {
    text: string;
    /** Transcript provenance, used to decide whether to look for speakers. */
    source?: string | null;
    model?: string | null;
    /**
     * Turns as the provider reported them. Preferred over re-deriving them
     * from the text: the provider's own grouping is authoritative, and only
     * these carry timings. Absent for transcripts written before turns were
     * stored, which fall back to the regex.
     */
    storedTurns?: TranscriptTurn[] | null;
    /** Confirmed names projected over raw labels without changing the text. */
    speakerAttributions?: SpeakerAttributions;
    /** Seek audio to a timed turn. Omitted when audio is unavailable. */
    onSeekToTurn?: (startMs: number) => void;
    /**
     * The player, for timed sentences to play from and to follow. Omitted
     * when audio is unavailable.
     */
    playback?: TranscriptPlayback;
    /** The scroll box the transcript sits in: it follows playback, and scrolling it seeks. */
    scrollRef?: RefObject<HTMLElement | null>;
    /**
     * Topics of this transcript. Each is shown as a heading above the stored
     * turn its start falls in; they need `storedTurns` to be placed.
     */
    topics?: TranscriptTopic[] | null;
    /** Topic to highlight briefly, after a jump to it. */
    highlightedTopic?: number | null;
    /** Turn selected by speaker playback navigation. */
    highlightedTurnIndex?: number | null;
    /**
     * A ready Learn review's proposals, shown in place for its reviewer:
     * provisional speaker names and underlined corrections, each ticked or
     * unticked in the review from here.
     */
    learnMarks?: LearnMarks | null;
    /**
     * The transcript's corrections, applied as people read them (absent
     * or null: the text as heard). In a turn with review marks, the marks
     * are shown instead.
     */
    corrections?: {
        list: readonly OverlayCorrection[];
        canUndo: boolean;
        onUndo?: (correctionId: string) => void;
    } | null;
}

interface RenderableTurn {
    speaker: string;
    label: string;
    text: string;
    startMs?: number;
}

/** A stretch of a paragraph: a sentence that plays, or the whole text. */
interface TextChunk {
    /** Index into the sentence starts; null when sentences do not play. */
    sentence: number | null;
    pieces: TurnPiece[];
}

/**
 * Sentence times inside a turn are interpolated and can start late; playing
 * from a little earlier keeps their first word.
 */
const SENTENCE_PREROLL_MS = 300;

/** A chunk's text without its trailing space, which stays outside the sentence's wash. */
function withoutTrailingSpace(pieces: readonly TurnPiece[]): {
    body: TurnPiece[];
    trailing: string;
} {
    const last = pieces.at(-1);
    if (!last || last.correction || last.mark) {
        return { body: [...pieces], trailing: "" };
    }
    const text = last.text.trimEnd();
    const body = pieces.slice(0, -1);
    if (text) body.push({ text });
    return { body, trailing: last.text.slice(text.length) };
}

/** A sentence's background: strong while played, soft while paused on, else only on hover. */
function sentenceWash(
    accent: SpeakerAccent,
    active: boolean,
    playing: boolean,
): string {
    if (!active) return accent.hover;
    return playing ? accent.strong : accent.soft;
}

function formatTimestamp(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? [hours, minutes, seconds]
              .map((value) => String(value).padStart(2, "0"))
              .join(":")
        : [minutes, seconds]
              .map((value) => String(value).padStart(2, "0"))
              .join(":");
}

/**
 * A turn's pieces cut where its paragraphs start. A cut inside corrected or
 * marked words moves to their end.
 */
function piecesByParagraph(
    pieces: readonly TurnPiece[],
    cuts: readonly number[],
): TurnPiece[][] {
    const out: TurnPiece[][] = [[]];
    const push = (piece: TurnPiece) => {
        const paragraph = out[out.length - 1];
        if (paragraph.length === 0 && !piece.correction && !piece.mark) {
            const text = piece.text.trimStart();
            if (text) paragraph.push({ text });
            return;
        }
        paragraph.push(piece);
    };
    let at = 0;
    let next = 0;
    for (const piece of pieces) {
        const end =
            at +
            (piece.correction
                ? piece.correction.heard.length
                : piece.text.length);
        if (piece.correction || piece.mark) {
            for (; next < cuts.length && cuts[next] <= at; next++) out.push([]);
            push(piece);
        } else {
            let from = at;
            for (; next < cuts.length && cuts[next] < end; next++) {
                const cut = Math.max(cuts[next], from);
                if (cut > from) {
                    push({ text: piece.text.slice(from - at, cut - at) });
                }
                out.push([]);
                from = cut;
            }
            if (from < end) push({ text: piece.text.slice(from - at) });
        }
        at = end;
    }
    for (; next < cuts.length; next++) out.push([]);
    return out;
}

/**
 * A transcript, rendered as a dialog when it has speaker turns to show and as
 * plain text otherwise.
 *
 * The dialog is gated twice. `mayBeDiarized` asks whether this transcript came
 * from a path that emits speaker labels, so an undiarized transcript that
 * happens to contain a line like "Note: ..." is never examined.
 * `parseSpeakerTurns` then asks whether labels actually arrived, because a
 * diarizing model can still answer with one unlabelled block.
 *
 * Long stored turns are read in paragraphs, each topic heading the one it
 * starts in. With a single speaker, as in a lecture, the speaker is not
 * named on every paragraph: each starts with its time instead.
 */
export function TranscriptView({
    text,
    source,
    model,
    storedTurns,
    speakerAttributions = {},
    onSeekToTurn,
    playback,
    scrollRef,
    topics,
    highlightedTopic = null,
    highlightedTurnIndex = null,
    learnMarks = null,
    corrections = null,
}: TranscriptViewProps) {
    const i18n = useExtracted();
    // Marks are anchored to stored turns; a transcript without them has none.
    const marksByTurn = useMemo(() => {
        const byTurn = new Map<number, LearnCorrectionMark[]>();
        if (!learnMarks || !storedTurns?.length) return byTurn;
        for (const mark of learnMarks.corrections) {
            byTurn.set(mark.turnIndex, [
                ...(byTurn.get(mark.turnIndex) ?? []),
                mark,
            ]);
        }
        return byTurn;
    }, [learnMarks, storedTurns]);
    const turns = useMemo<RenderableTurn[] | null>(() => {
        if (storedTurns?.length) {
            return storedTurns.map((turn) => ({
                speaker: turn.speaker,
                label: formatSpeakerLabel(turn.speaker),
                text: turn.text,
                startMs: turn.startMs,
            }));
        }
        if (!mayBeDiarized({ source, model })) return null;
        return parseSpeakerTurns(text);
    }, [text, source, model, storedTurns]);
    // Only stored turns carry the timings that paragraphs and topics need.
    const { paragraphs, topicParagraphs } = useMemo<{
        paragraphs: TranscriptParagraph[];
        topicParagraphs: number[];
    }>(() => {
        if (storedTurns?.length) {
            return paragraphsOf(
                storedTurns,
                (topics ?? []).map((topic) => topic.fromMs),
            );
        }
        return {
            paragraphs: (turns ?? []).map((turn, turnIndex) => ({
                turnIndex,
                charStart: 0,
                startMs: turn.startMs ?? Number.NaN,
            })),
            topicParagraphs: [],
        };
    }, [storedTurns, topics, turns]);
    // Sentences play once their times can be told: from stored turns with
    // times, and audio to play.
    const timed = Boolean(storedTurns?.length) && !isUntimed(storedTurns ?? []);
    const bySentence = playback !== undefined && timed;
    // Each paragraph's text: corrections applied and review marks in place,
    // both anchored to the stored turn it is cut from, and cut into the
    // sentences that play.
    const { chunks, startsMs } = useMemo(() => {
        const chunks: TextChunk[][] = [];
        const startsMs: number[] = [];
        if (!turns) return { chunks, startsMs };
        const list = storedTurns?.length ? (corrections?.list ?? []) : [];
        const cutsByTurn = new Map<number, number[]>();
        for (const paragraph of paragraphs) {
            if (paragraph.charStart === 0) continue;
            const cuts = cutsByTurn.get(paragraph.turnIndex);
            if (cuts) cuts.push(paragraph.charStart);
            else cutsByTurn.set(paragraph.turnIndex, [paragraph.charStart]);
        }
        turns.forEach((turn, turnIndex) => {
            const paragraphCuts = cutsByTurn.get(turnIndex) ?? [];
            const stored = bySentence ? storedTurns?.[turnIndex] : undefined;
            const sentences = stored ? sentenceStarts(stored) : [];
            const msAt = new Map(sentences.map(({ at, ms }) => [at, ms]));
            const cuts = stored
                ? [
                      ...new Set([
                          ...paragraphCuts,
                          ...sentences.slice(1).map(({ at }) => at),
                      ]),
                  ].sort((a, b) => a - b)
                : paragraphCuts;
            const parts = piecesByParagraph(
                turnPieces(
                    turn.text,
                    turnIndex,
                    list,
                    marksByTurn.get(turnIndex) ?? [],
                ),
                cuts,
            );
            parts.forEach((part, partIndex) => {
                const at = partIndex === 0 ? 0 : cuts[partIndex - 1];
                if (partIndex === 0 || paragraphCuts.includes(at)) {
                    chunks.push([]);
                }
                let sentence: number | null = null;
                if (stored) {
                    const estimated = msAt.get(at) ?? stored.startMs;
                    startsMs.push(
                        partIndex === 0
                            ? stored.startMs
                            : Math.max(
                                  stored.startMs,
                                  estimated - SENTENCE_PREROLL_MS,
                              ),
                    );
                    sentence = startsMs.length - 1;
                }
                chunks[chunks.length - 1].push({ sentence, pieces: part });
            });
        });
        return { chunks, startsMs };
    }, [turns, storedTurns, corrections, marksByTurn, paragraphs, bySentence]);
    const rootRef = useRef<HTMLDivElement>(null);
    const follow = useTranscriptFollow({
        rootRef,
        scrollRef,
        playback: bySentence ? playback : undefined,
        startsMs,
        holdScroll: highlightedTopic !== null || highlightedTurnIndex !== null,
    });
    const topicsByParagraph = new Map<number, number[]>();
    topicParagraphs.forEach((paragraphIndex, topicIndex) => {
        topicsByParagraph.set(paragraphIndex, [
            ...(topicsByParagraph.get(paragraphIndex) ?? []),
            topicIndex,
        ]);
    });
    const highlightedParagraph =
        highlightedTopic !== null && topics?.[highlightedTopic]
            ? (topicParagraphs[highlightedTopic] ?? null)
            : null;

    if (!turns) {
        return (
            <p className="text-sm whitespace-pre-wrap leading-relaxed">
                {text}
            </p>
        );
    }

    const order = speakerOrder(turns);
    // A lone speaker is named only while a review proposes a name for them.
    const loneKey = order.length === 1 ? speakerKey(order[0]) : null;
    const showSpeakers =
        loneKey === null ||
        (speakerAttributions[loneKey]?.name === undefined &&
            Boolean(storedTurns?.length) &&
            learnMarks?.speakers[loneKey] !== undefined);
    // From the first topic on, paragraphs sit inside their topic, under its title.
    const firstTopicParagraph =
        topicsByParagraph.size > 0
            ? Math.min(...topicsByParagraph.keys())
            : null;
    // The accept button goes on a speaker's first turn only.
    const firstTurnOf = new Map<string, number>();
    turns.forEach((turn, index) => {
        const key = speakerKey(turn.speaker);
        if (!firstTurnOf.has(key)) firstTurnOf.set(key, index);
    });
    const handleSentenceClick = (event: MouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!playback || !(target instanceof Element)) return;
        // Corrections, review marks and links answer their own clicks.
        if (target.closest("button, a")) return;
        const sentence = target.closest<HTMLElement>("[data-sentence]");
        if (!sentence || window.getSelection()?.toString()) return;
        const index = Number(sentence.dataset.sentence);
        if (index === follow.active && follow.playing) playback.pause();
        else if (Number.isFinite(startsMs[index])) {
            playback.play(startsMs[index]);
        }
    };
    const renderPieces = (pieces: readonly TurnPiece[]) =>
        pieces.map((piece, pieceIndex) =>
            piece.mark && learnMarks ? (
                <MarkedText
                    // Pieces are fixed by the text, its corrections and marks.
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                    key={pieceIndex}
                    text={piece.text}
                    marks={[
                        {
                            ...piece.mark,
                            charStart: 0,
                            charEnd: piece.text.length,
                        },
                    ]}
                    decide={learnMarks.decide}
                />
            ) : piece.correction ? (
                <CorrectedText
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                    key={pieceIndex}
                    segments={[piece]}
                    onUndo={
                        corrections?.canUndo ? corrections.onUndo : undefined
                    }
                />
            ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                <Fragment key={pieceIndex}>{piece.text}</Fragment>
            ),
        );

    return (
        // Sentences are a pointer shortcut; each paragraph's play button is
        // the keyboard path.
        // biome-ignore lint/a11y/noStaticElementInteractions: delegated sentence clicks
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above
        <div
            ref={rootRef}
            className="relative space-y-4"
            onClick={bySentence ? handleSentenceClick : undefined}
        >
            {paragraphs.map((paragraph, index) => {
                const turnIndex = paragraph.turnIndex;
                const turn = turns[turnIndex];
                const opensTurn =
                    paragraphs[index - 1]?.turnIndex !== turnIndex;
                const named = showSpeakers && turn.label !== "";
                const position = order.indexOf(turn.speaker);
                const style = speakerAccent(position);
                const key = speakerKey(turn.speaker);
                const confirmedName = speakerAttributions[key]?.name;
                const proposed =
                    confirmedName === undefined && storedTurns?.length
                        ? learnMarks?.speakers[key]
                        : undefined;
                const displayName =
                    confirmedName ??
                    (proposed ? `${proposed.name}?` : turn.label);
                const nameStyle = proposed ? "italic" : "";
                const canSeek =
                    onSeekToTurn !== undefined &&
                    Number.isFinite(paragraph.startMs);
                const chunksHere = chunks[index] ?? [];
                const firstSentence = chunksHere[0]?.sentence ?? null;
                const gutter = named || bySentence;
                const time = formatTimestamp(paragraph.startMs);
                const playButton =
                    playback && firstSentence !== null ? (
                        <button
                            type="button"
                            className={`group/play absolute top-0 left-0 grid size-5 place-items-center rounded-full ${style.text} ${style.hover} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                            onClick={() =>
                                playback.play(startsMs[firstSentence])
                            }
                            aria-label={
                                named
                                    ? i18n("Play from {time}, {speaker}", {
                                          time,
                                          speaker: displayName,
                                      })
                                    : i18n("Play from {time}", { time })
                            }
                        >
                            {named && (
                                <span
                                    className={`size-1.5 rounded-full transition-opacity group-hover/para:opacity-0 group-focus-visible/play:opacity-0 ${style.dot}`}
                                />
                            )}
                            <Play className="absolute size-3 fill-current opacity-0 transition-opacity group-hover/para:opacity-100 group-focus-visible/play:opacity-100" />
                        </button>
                    ) : null;
                const speakerMark = playButton ?? (
                    <span
                        className={`absolute top-[7px] left-[7px] size-1.5 rounded-full ${style.dot}`}
                    />
                );
                return (
                    <Fragment
                        key={`${turn.speaker}-${turnIndex}-${paragraph.charStart}`}
                    >
                        {topicsByParagraph.get(index)?.map((topicIndex) => {
                            const topic = (topics as TranscriptTopic[])[
                                topicIndex
                            ];
                            // The same form as the topics list, so both read alike.
                            const time = formatClock(topic.fromMs);
                            return (
                                <div
                                    key={`topic-${topicIndex}-${topic.fromMs}`}
                                    data-topic-index={topicIndex}
                                    className={`flex scroll-mt-2 items-baseline gap-2 rounded-md border-t border-border/60 px-1 pt-4 transition-colors duration-700 ${topicIndex === 0 && index === 0 ? "border-t-0 pt-0" : ""} ${highlightedTopic === topicIndex ? "bg-primary/10" : ""}`}
                                >
                                    <span className="w-7 shrink-0 text-base font-semibold tabular-nums text-primary">
                                        {topicIndex + 1}.
                                    </span>
                                    <h4 className="min-w-0 flex-1 text-base font-semibold leading-snug">
                                        {topic.title}
                                    </h4>
                                    {onSeekToTurn ? (
                                        <button
                                            type="button"
                                            className="shrink-0 rounded-sm font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() =>
                                                onSeekToTurn(topic.fromMs)
                                            }
                                            aria-label={i18n(
                                                "Jump to topic {title} at {time}",
                                                { title: topic.title, time },
                                            )}
                                        >
                                            {time}
                                        </button>
                                    ) : (
                                        <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                            {time}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        <div
                            data-turn-index={opensTurn ? turnIndex : undefined}
                            data-accent={Math.max(0, position)}
                            className={`group/para relative space-y-1 rounded-md transition-colors duration-700 ${gutter ? "pl-6" : ""} ${firstTopicParagraph !== null && index >= firstTopicParagraph ? "ml-10" : ""} ${highlightedParagraph === index || highlightedTurnIndex === turnIndex ? "bg-primary/10" : ""}`}
                        >
                            {!named && canSeek && playButton}
                            {!named && canSeek && (
                                <button
                                    type="button"
                                    className="inline-flex min-h-5 items-center rounded-sm font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    onClick={() =>
                                        onSeekToTurn(paragraph.startMs)
                                    }
                                    aria-label={i18n("Seek audio to {time}", {
                                        time: formatTimestamp(
                                            paragraph.startMs,
                                        ),
                                    })}
                                >
                                    {formatTimestamp(paragraph.startMs)}
                                </button>
                            )}
                            {named && opensTurn && (
                                <div className="flex min-h-5 items-center gap-2">
                                    {speakerMark}
                                    {canSeek ? (
                                        <button
                                            type="button"
                                            className={`rounded-sm text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${style.text} ${nameStyle}`}
                                            onClick={() =>
                                                onSeekToTurn(turn.startMs ?? 0)
                                            }
                                            aria-label={i18n(
                                                "Seek audio to {time}, {speaker}",
                                                {
                                                    time: formatTimestamp(
                                                        turn.startMs ?? 0,
                                                    ),
                                                    speaker: displayName,
                                                },
                                            )}
                                            title={i18n(
                                                "Seek audio to {time}",
                                                {
                                                    time: formatTimestamp(
                                                        turn.startMs ?? 0,
                                                    ),
                                                },
                                            )}
                                        >
                                            {displayName}
                                        </button>
                                    ) : (
                                        <span
                                            className={`text-xs font-medium ${style.text} ${nameStyle}`}
                                        >
                                            {displayName}
                                        </span>
                                    )}
                                    {timed && (
                                        <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                            {time}
                                        </span>
                                    )}
                                    {proposed &&
                                        learnMarks &&
                                        firstTurnOf.get(key) === index && (
                                            <button
                                                type="button"
                                                className={`inline-flex items-center gap-0.5 rounded-sm border px-1 text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${proposed.ticked ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground hover:text-foreground"}`}
                                                aria-pressed={proposed.ticked}
                                                title={i18n(
                                                    "Suggested by Learn. Applied when you finish the review.",
                                                )}
                                                aria-label={
                                                    proposed.ticked
                                                        ? i18n(
                                                              "{name} is ticked for this speaker in the review: untick",
                                                              {
                                                                  name: proposed.name,
                                                              },
                                                          )
                                                        : i18n(
                                                              "Accept {name} for this speaker in the review",
                                                              {
                                                                  name: proposed.name,
                                                              },
                                                          )
                                                }
                                                onClick={() =>
                                                    learnMarks.decide(
                                                        proposed.itemId,
                                                        proposed.ticked
                                                            ? "rejected"
                                                            : "accepted",
                                                    )
                                                }
                                            >
                                                <Check className="size-3" />
                                            </button>
                                        )}
                                </div>
                            )}
                            <p className="text-sm whitespace-pre-wrap leading-relaxed">
                                {chunksHere.map((chunk, chunkIndex) => {
                                    if (chunk.sentence === null) {
                                        return (
                                            <Fragment
                                                // Chunks are fixed by the text and its sentences.
                                                // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                                                key={chunkIndex}
                                            >
                                                {renderPieces(chunk.pieces)}
                                            </Fragment>
                                        );
                                    }
                                    const { body, trailing } =
                                        withoutTrailingSpace(chunk.pieces);
                                    if (body.length === 0) {
                                        return (
                                            <Fragment key={chunk.sentence}>
                                                {trailing}
                                            </Fragment>
                                        );
                                    }
                                    const wash = sentenceWash(
                                        style,
                                        follow.active === chunk.sentence,
                                        follow.playing,
                                    );
                                    return (
                                        <Fragment key={chunk.sentence}>
                                            <span
                                                data-sentence={chunk.sentence}
                                                className={`cursor-pointer rounded-[3px] box-decoration-clone transition-colors ${wash}`}
                                            >
                                                {renderPieces(body)}
                                            </span>
                                            {trailing}
                                        </Fragment>
                                    );
                                })}
                            </p>
                        </div>
                    </Fragment>
                );
            })}
            {bySentence && (
                <TranscriptPlayMarker
                    rootRef={rootRef}
                    active={follow.active}
                    playing={follow.playing}
                />
            )}
        </div>
    );
}
