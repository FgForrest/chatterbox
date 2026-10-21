/** Identify the owner-scoped row that drives an item's workflow in every content view. */
export function pipelineDriver(ownerUserId: string) {
    return { userId: ownerUserId, view: "private" as const };
}
