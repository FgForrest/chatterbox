const credentialTokens = new Set([
    "username",
    "email",
    "current-password",
    "new-password",
    "one-time-code",
]);

/** Opt non-login fields out; secrets also block saved-password filling with new-password. */
export function getPasswordManagerAttributes(
    autoComplete?: string,
    { secret = false }: { secret?: boolean } = {},
) {
    if (
        !secret &&
        autoComplete
            ?.trim()
            .toLowerCase()
            .split(/\s+/)
            .some((token) => credentialTokens.has(token))
    ) {
        return { autoComplete };
    }

    return {
        autoComplete: secret ? "new-password" : "off",
        "data-bwignore": "true",
        "data-1p-ignore": "true",
        "data-lpignore": "true",
        "data-form-type": "other",
    } as const;
}
