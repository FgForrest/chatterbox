import { describe, expect, it } from "vitest";
import {
    rankTaskCandidates,
    rankTaskSearchCandidates,
    TASK_CANDIDATE_LIMIT,
    topTaskCandidates,
} from "@/lib/tasks/ranking";

function candidate(
    id: string,
    text: string,
    options: {
        assigneePersonId?: string | null;
        statementAt?: Date;
        vector?: Float32Array | null;
    } = {},
) {
    return {
        id,
        text,
        assigneePersonId: options.assigneePersonId ?? null,
        statementAt:
            options.statementAt ?? new Date("2026-10-01T00:00:00.000Z"),
        vector: options.vector,
    };
}

describe("task candidate ranking", () => {
    it("orders lexicographically by similarity, shared participant, then recency", () => {
        const ranked = rankTaskCandidates({
            itemText: "Prepare the launch pricing page",
            participantPersonIds: ["person-shared"],
            candidates: [
                candidate("recent", "Unrelated work", {
                    statementAt: new Date("2026-10-04T00:00:00.000Z"),
                }),
                candidate("shared", "Unrelated work", {
                    assigneePersonId: "person-shared",
                    statementAt: new Date("2026-10-02T00:00:00.000Z"),
                }),
                candidate("similar", "Prepare the pricing page", {
                    statementAt: new Date("2026-10-01T00:00:00.000Z"),
                }),
                candidate("older-tie", "Completely different", {
                    statementAt: new Date("2026-10-02T00:00:00.000Z"),
                }),
            ],
        });

        expect(ranked.map((entry) => entry.candidate.id)).toEqual([
            "similar",
            "shared",
            "recent",
            "older-tie",
        ]);
        expect(ranked[0]?.similarity).toBeGreaterThan(0);
        expect(ranked[1]).toMatchObject({
            sharedParticipants: 1,
        });
        expect(ranked[2]?.recency).toBeGreaterThan(ranked[3]?.recency ?? 0);
    });

    it("normalizes Czech and English words and ignores their stop words", () => {
        const ranked = rankTaskCandidates({
            itemText: "Připravit návrh pro klienta and send it to the team",
            participantPersonIds: [],
            candidates: [
                candidate("match", "pripravit navrh klienta send team"),
                candidate("other", "objednat oběd"),
            ],
        });

        expect(ranked[0]?.candidate.id).toBe("match");
        expect(ranked[0]?.similarity).toBe(1);
    });

    it("groups complete and partial prefix matches without disturbing ranking order", () => {
        const ranked = rankTaskCandidates({
            itemText: "unrelated",
            participantPersonIds: [],
            candidates: [
                candidate("partial", "Mólo crane"),
                candidate("complete", "Inspect the mólo crane"),
                candidate("inflected", "Secure the lana"),
                candidate("none", "Book catering"),
            ],
        });

        expect(
            rankTaskSearchCandidates(ranked, "inspect mol", false).map(
                (entry) => entry.candidate.id,
            ),
        ).toEqual(["complete", "partial"]);
        expect(
            rankTaskSearchCandidates(ranked, "lano", false).map(
                (entry) => entry.candidate.id,
            ),
        ).toEqual(["inflected"]);
        expect(
            rankTaskSearchCandidates(ranked, "inspect mol", true).map(
                (entry) => entry.candidate.id,
            ),
        ).toEqual(["complete", "partial", "inflected", "none"]);
        expect(rankTaskSearchCandidates(ranked, "m", false)).toEqual([]);
    });

    it("keeps stable ties and caps the prompt list at the exported limit", () => {
        const candidates = Array.from(
            { length: TASK_CANDIDATE_LIMIT + 2 },
            (_, index) => candidate(`task-${index}`, "same words"),
        );
        const input = {
            itemText: "different words",
            participantPersonIds: [] as string[],
            candidates,
        };

        expect(
            rankTaskCandidates(input).map((entry) => entry.candidate.id),
        ).toEqual(candidates.map((entry) => entry.id));
        expect(topTaskCandidates(input)).toHaveLength(TASK_CANDIDATE_LIMIT);
        expect(
            topTaskCandidates(input).map((entry) => entry.candidate.id),
        ).toEqual(
            candidates.slice(0, TASK_CANDIDATE_LIMIT).map((entry) => entry.id),
        );
    });
});
