import type { LearnOutput } from "@/lib/learn/output";
import { isUnmentionedSpeaker } from "@/lib/learn/review-policy";
import { type LearnRunFrame, validateLearnOutput } from "@/lib/learn/validate";

/** Validate model proposals for assertions independent of optional coverage rows. */
export function validateLearnProposals(
    output: LearnOutput,
    frame: LearnRunFrame,
) {
    const result = validateLearnOutput(output, frame);
    return {
        ...result,
        items: result.items.filter((item) => !isUnmentionedSpeaker(item)),
    };
}
