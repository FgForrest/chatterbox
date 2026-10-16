import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/knowledge/knowledge-loader", () => ({
    findByName: vi.fn(),
    searchByMeaning: vi.fn(),
}));

import type { AlmanacUsageRow } from "@/db/queries/almanac-usage";
import {
    type FoundEntity,
    findEntitiesInView,
    rankFoundEntities,
} from "@/lib/knowledge/find-entities";
import {
    findByName,
    type KnowledgeView,
    searchByMeaning,
} from "@/lib/knowledge/knowledge-loader";

function found(id: string, score: number): FoundEntity {
    return {
        id,
        kind: "entity",
        typeKey: "project",
        name: id,
        scope: "personal",
        reasons: ["token"],
        score,
    };
}

function used(id: string, recent: number, total: number): AlmanacUsageRow {
    return {
        personId: null,
        entityId: id,
        recent,
        total,
        lastAt: new Date("2026-10-01T00:00:00Z"),
    };
}

describe("Learn folder ranking", () => {
    it("uses scope only to break equal text-match scores", () => {
        const candidates = [
            found("strong", 10),
            found("outside", 5),
            found("scope", 5),
        ];

        expect(rankFoundEntities(candidates).map((item) => item.id)).toEqual([
            "strong",
            "outside",
            "scope",
        ]);
        expect(
            rankFoundEntities(candidates, [used("scope", 2, 3)]).map(
                (item) => item.id,
            ),
        ).toEqual(["strong", "scope", "outside"]);
    });

    it("applies the scope tie-breaker in the Learn lookup", async () => {
        vi.mocked(findByName).mockReturnValue([
            { id: "outside", name: "outside", reason: "token", score: 5 },
            { id: "scope", name: "scope", reason: "token", score: 5 },
        ]);
        vi.mocked(searchByMeaning).mockResolvedValue({
            available: false,
            hits: [],
        });
        const view: KnowledgeView = {
            items: ["outside", "scope"].map((id) => ({
                id,
                kind: "entity" as const,
                typeKey: "project",
                name: id,
                description: null,
                scope: "personal" as const,
                notes: null,
                names: [],
            })),
            facts: [],
            indexes: [],
            vectors: [],
        };

        const result = await findEntitiesInView(view, {
            text: "project",
            scopeUsage: [used("scope", 1, 1)],
        });

        expect(result.entities.map((item) => item.id)).toEqual([
            "scope",
            "outside",
        ]);
    });
});
