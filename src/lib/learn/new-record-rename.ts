import { heardIsTheName, nameWords } from "@/lib/learn/name-match";
import type { TranscriptTurn } from "@/lib/transcription/turns";

export interface RenamedRecordPlace {
    turnIndex: number;
    charStart: number;
    charEnd: number;
    heard: string;
    replacement: string;
}

/** Grounded places a review rename can rewrite without guessing declension. */
export function renamedRecordPlaces(
    proposed: string,
    renamed: string,
    turns: readonly TranscriptTurn[],
): RenamedRecordPlace[] {
    const original =
        proposed.normalize("NFC").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    const edited = renamed.normalize("NFC").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    if (original.length === 0 || edited.length !== original.length) return [];
    const places: RenamedRecordPlace[] = [];
    turns.forEach((turn, turnIndex) => {
        const words = [...turn.text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)];
        for (let index = 0; index + original.length <= words.length; index++) {
            const first = words[index];
            const last = words[index + original.length - 1];
            if (!first || !last) continue;
            const charStart = first.index;
            const charEnd = last.index + last[0].length;
            const heard = turn.text.slice(charStart, charEnd);
            if (
                !/^[\p{L}\p{N}\p{M}]+(?:[\s'-]+[\p{L}\p{N}\p{M}]+)*$/u.test(
                    heard,
                )
            )
                continue;
            if (!heardIsTheName(heard, proposed)) continue;
            const heardWords = words.slice(index, index + original.length);
            const suffixes = heardWords.map((word, offset) => {
                const base = original[offset] ?? "";
                const folded = nameWords(word[0])[0] ?? "";
                const wanted = nameWords(base)[0] ?? "";
                if (!folded.startsWith(wanted)) return null;
                return word[0].normalize("NFC").slice(base.length);
            });
            let replacement: string;
            if (suffixes.every((suffix) => suffix === "")) {
                replacement = renamed;
            } else if (
                edited.length === original.length &&
                edited.every(
                    (word, offset) =>
                        (nameWords(word)[0] ?? "").slice(-2) ===
                        (nameWords(original[offset] ?? "")[0] ?? "").slice(-2),
                ) &&
                suffixes.every((suffix) => suffix !== null)
            ) {
                replacement = edited
                    .map((word, offset) => word + suffixes[offset])
                    .join(" ");
            } else {
                continue;
            }
            if (heard.normalize("NFC") === replacement.normalize("NFC"))
                continue;
            places.push({ turnIndex, charStart, charEnd, heard, replacement });
        }
    });
    return places;
}
