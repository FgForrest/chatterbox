import type { DefaultProviderPointers } from "@/lib/ai/default-provider";
import {
    isEnhancementOnlyProvider,
    isTranscriptionOnlyProvider,
} from "@/lib/ai/provider-presets";

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
        | "member-fallback"
        | "organization-fallback";
    providerId: string;
}

interface DefaultProviderCredential {
    id: string;
    provider: string;
    disabledAt?: Date | string | null;
    createdAt: Date | string;
    managed?: boolean;
}

/** Read default pointers from provider cards when no pointer payload is available. */
export function providerPointersFromFlags(
    credentials: {
        id: string;
        isDefaultTranscription?: boolean;
        isDefaultEnhancement?: boolean;
        isDefaultLearn?: boolean;
        isDefaultTopics?: boolean;
        isDefaultTitle?: boolean;
    }[],
): DefaultProviderPointers {
    return {
        transcription:
            credentials.find((row) => row.isDefaultTranscription)?.id ?? null,
        summary:
            credentials.find((row) => row.isDefaultEnhancement)?.id ?? null,
        learn: credentials.find((row) => row.isDefaultLearn)?.id ?? null,
        topics: credentials.find((row) => row.isDefaultTopics)?.id ?? null,
        title: credentials.find((row) => row.isDefaultTitle)?.id ?? null,
    };
}

/** Select the oldest enabled credential that supports a processing role. */
export function oldestSuitableProvider<T extends DefaultProviderCredential>(
    step: ResolutionStep,
    credentials: T[],
): T | undefined {
    return credentials
        .filter(
            (credential) =>
                credential.disabledAt == null &&
                credential.managed !== true &&
                (step === "transcription"
                    ? !isEnhancementOnlyProvider(credential.provider)
                    : !isTranscriptionOnlyProvider(credential.provider)),
        )
        .sort((left, right) => {
            const created =
                new Date(left.createdAt).getTime() -
                new Date(right.createdAt).getTime();
            return created === 0 ? left.id.localeCompare(right.id) : created;
        })[0];
}

/** Build the provider-pointer resolution order before managed fallback. */
export function defaultProviderCandidates(
    step: ResolutionStep,
    member: DefaultProviderPointers,
    organization: DefaultProviderPointers | null,
    memberCredentials: DefaultProviderCredential[] = [],
    organizationCredentials: DefaultProviderCredential[] = [],
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
        const fallback = oldestSuitableProvider(step, memberCredentials);
        if (fallback) {
            candidates.push({
                source: "member-fallback",
                providerId: fallback.id,
            });
        }
    }
    if (organization) {
        const fallback = oldestSuitableProvider(step, organizationCredentials);
        if (fallback) {
            candidates.push({
                source: "organization-fallback",
                providerId: fallback.id,
            });
        }
    }
    return candidates;
}
