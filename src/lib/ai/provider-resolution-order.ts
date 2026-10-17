import type { DefaultProviderPointers } from "@/lib/ai/default-provider";
import { isTranscriptionOnlyProvider } from "@/lib/ai/provider-presets";

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
        | "organization-summary"
        | "member-fallback";
    providerId: string;
}

interface DefaultProviderCredential {
    id: string;
    provider: string;
    disabledAt?: Date | string | null;
    createdAt: Date | string;
}

/** Build the provider-pointer resolution order before managed fallback. */
export function defaultProviderCandidates(
    step: ResolutionStep,
    member: DefaultProviderPointers,
    organization: DefaultProviderPointers | null,
    memberCredentials: DefaultProviderCredential[] = [],
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
        return candidates;
    }
    if (step !== "transcription") {
        const fallback = memberCredentials
            .filter(
                (credential) =>
                    credential.disabledAt == null &&
                    !isTranscriptionOnlyProvider(credential.provider),
            )
            .sort((left, right) => {
                const created =
                    new Date(left.createdAt).getTime() -
                    new Date(right.createdAt).getTime();
                return created === 0
                    ? left.id.localeCompare(right.id)
                    : created;
            })[0];
        if (fallback) {
            candidates.push({
                source: "member-fallback",
                providerId: fallback.id,
            });
        }
    }
    return candidates;
}
