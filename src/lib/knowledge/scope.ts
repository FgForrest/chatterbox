/**
 * Which knowledge scopes a reader may read. Every read of knowledge goes
 * through this, so the private layer stays private by one rule rather
 * than by each query remembering it.
 *
 * - A run on a private recording reads the Organization's knowledge and
 *   the owner's, and writes the owner's.
 * - A run on a shared recording reads and writes the Organization's alone,
 *   so nothing private surfaces in shared text.
 * - The People and entity pages show a person the Organization's
 *   knowledge and their own.
 *
 * Without an Organization (local mode) only the owner's or the viewer's.
 * Pure: the caller resolves the organization account.
 */

export type ReadContext =
    | { kind: "recording"; ownerUserId: string; shared: boolean }
    | { kind: "pages"; viewerUserId: string };

export function readableScopes(
    context: ReadContext,
    orgUserId: string | null,
): string[] {
    const own =
        context.kind === "recording"
            ? context.ownerUserId
            : context.viewerUserId;
    if (!orgUserId) return [own];
    if (context.kind === "recording" && context.shared) return [orgUserId];
    return own === orgUserId ? [orgUserId] : [orgUserId, own];
}
