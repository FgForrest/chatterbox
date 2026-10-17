import type { DefaultProviderPointers } from "@/lib/ai/default-provider";

export type ResolutionStep =
    | "transcription"
    | "summary"
    | "learn"
    | "topics"
    | "title";

export interface DefaultProviderCandidate {
    source:
        | "member-role"
        | "member-summary"
        | "organization-role"
        | "organization-summary";
    providerId: string;
}

/** Build the provider-pointer resolution order before managed fallback. */
export function defaultProviderCandidates(
    step: ResolutionStep,
    member: DefaultProviderPointers,
    organization: DefaultProviderPointers | null,
): DefaultProviderCandidate[] {
    const candidates: DefaultProviderCandidate[] = [];
    const memberRole = member[step];
    if (memberRole) {
        candidates.push({ source: "member-role", providerId: memberRole });
        return candidates;
    }
    const followsSummary =
        step === "topics" || step === "title" || step === "learn";
    if (followsSummary && member.summary) {
        candidates.push({
            source: "member-summary",
            providerId: member.summary,
        });
        return candidates;
    }
    const organizationRole = organization?.[step];
    if (organizationRole) {
        candidates.push({
            source: "organization-role",
            providerId: organizationRole,
        });
        return candidates;
    }
    if (followsSummary && organization?.summary) {
        candidates.push({
            source: "organization-summary",
            providerId: organization.summary,
        });
    }
    return candidates;
}
