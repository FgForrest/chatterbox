import { folderShareProblemRefs } from "@/db/queries/almanac-share";
import { openCareProblems } from "@/lib/knowledge/care";
import { canOpenCare, requireCareCurator } from "@/lib/knowledge/care-access";
import type { CareProblem } from "@/lib/knowledge/care-types";
import {
    careDuplicateCandidates,
    type DuplicateCandidate,
} from "@/lib/knowledge/duplicates";

export interface FolderCare {
    problems: CareProblem[];
    duplicates: DuplicateCandidate[];
    shareRefs?: { id: string; kind: "record" | "fact"; eventId: string }[];
}

/** Curator-only flags for the page's Organization records; ordinary viewers get no Care data. */
export async function folderCareFor(
    actorId: string,
    recordIds: string[],
    factIds: string[] = [],
): Promise<{ care?: FolderCare }> {
    if (!(await canOpenCare(actorId))) return {};
    const scope = await requireCareCurator(actorId);
    const [problems, duplicates, shared] = await Promise.all([
        openCareProblems(actorId),
        careDuplicateCandidates(actorId),
        folderShareProblemRefs(scope, recordIds, factIds),
    ]);
    const ids = new Set(recordIds);
    const facts = new Set(factIds);
    return {
        care: {
            shareRefs: shared.map((row) => ({
                id: row.id,
                kind: row.kind,
                eventId: row.event_id,
            })),
            problems: problems.filter(
                (problem) =>
                    problem.records.some((record) => ids.has(record.id)) ||
                    problem.options.some((option) => facts.has(option.id)),
            ),
            duplicates: duplicates.filter(
                (pair) => ids.has(pair.left.id) || ids.has(pair.right.id),
            ),
        },
    };
}
