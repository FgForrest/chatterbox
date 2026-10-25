import { openCareProblems } from "@/lib/knowledge/care";
import { careDuplicateCandidates } from "@/lib/knowledge/duplicates";
import { shareReviewCount } from "@/lib/knowledge/share-review";

/** Count every open kind using generation-cached scans and a bounded recent-share query. */
export async function careCount(actorId: string): Promise<number> {
    const [problems, duplicates, shares] = await Promise.all([
        openCareProblems(actorId),
        careDuplicateCandidates(actorId),
        shareReviewCount(actorId),
    ]);
    return problems.length + duplicates.length + shares;
}
