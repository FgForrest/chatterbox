import { normalizeForLookup } from "@/lib/knowledge/lookup-hash";

/** Whether a person's primary email identifies the signed-in account. */
export function isOwnPerson(
    primaryEmail: string | null,
    accountEmail: string | null | undefined,
): boolean {
    const email = normalizeForLookup(accountEmail ?? "");
    return Boolean(email) && normalizeForLookup(primaryEmail ?? "") === email;
}
