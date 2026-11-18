import { openCareProblems } from "@/lib/knowledge/care";
import { careDuplicateCandidates } from "@/lib/knowledge/duplicates";

/** Count open Care problems and duplicate candidates using generation-cached scans. */
export async function careCount(actorId: string): Promise<number> {
    const [problems, duplicates] = await Promise.all([
        openCareProblems(actorId),
        careDuplicateCandidates(actorId),
    ]);
    return problems.length + duplicates.length;
}
