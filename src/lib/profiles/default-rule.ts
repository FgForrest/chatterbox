export type DefaultProfileRuleResult =
    | {
          kind: "resolved";
          profileId: string;
          source: "pointer" | "personal" | "organization";
      }
    | { kind: "explicit_unavailable"; profileId: string }
    | { kind: "missing" };

/** Apply the authoritative member-default precedence without database access. */
export function defaultProfileRule(input: {
    pointerId: string | null;
    pointerProfileId: string | null;
    personalDefaultId: string | null;
    organizationDefaultId: string | null;
}): DefaultProfileRuleResult {
    if (input.pointerId) {
        if (input.pointerProfileId === input.pointerId) {
            return {
                kind: "resolved",
                profileId: input.pointerId,
                source: "pointer",
            };
        }
        return { kind: "explicit_unavailable", profileId: input.pointerId };
    }
    if (input.personalDefaultId) {
        return {
            kind: "resolved",
            profileId: input.personalDefaultId,
            source: "personal",
        };
    }
    if (input.organizationDefaultId) {
        return {
            kind: "resolved",
            profileId: input.organizationDefaultId,
            source: "organization",
        };
    }
    return { kind: "missing" };
}
