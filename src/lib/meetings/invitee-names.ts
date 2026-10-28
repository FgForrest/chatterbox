/** Render known names and count unnamed invitees without exposing contact details. */
export function inviteeNames(invitees: readonly { name: string }[]): string {
    const names = invitees
        .map((invitee) => invitee.name.trim())
        .filter(Boolean);
    const unnamed = invitees.length - names.length;
    return `${names.join(", ")}${unnamed ? `${names.length ? " " : ""}+${unnamed}` : ""}`;
}
