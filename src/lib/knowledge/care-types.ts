import type { DuplicateKind } from "@/lib/knowledge/duplicate-score";

export type CareProblemKind = "fact_conflict" | "correction_conflict" | "thin";
export interface CareRecord {
    id: string;
    kind: DuplicateKind;
    name: string;
}
export interface CareProblem {
    key: string;
    kind: CareProblemKind;
    records: CareRecord[];
    relationKey?: string;
    relationLabel?: string;
    heard?: string;
    options: { id: string; label: string; targetId?: string }[];
    lastAt?: string;
}
export interface CareProblemPage {
    problems: CareProblem[];
    counts: Record<CareProblemKind, number>;
    nextOffset: number | null;
    limited: boolean;
}

/** Portable problem content for restoring a decision after ids and encryption change. */
export function careProblemContent(problem: CareProblem) {
    return {
        kind: problem.kind,
        records: problem.records
            .map((record) => ({ ...record }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        relationKey: problem.relationKey ?? null,
        heard: problem.heard ?? null,
        values: problem.options.map((option) => option.label).sort(),
        lastAt: problem.lastAt ?? null,
    };
}
