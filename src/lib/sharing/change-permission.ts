interface ItemChangePermission {
    view: "private" | "org";
    isOwn: boolean;
    shared: boolean;
    isOrgAccount: boolean;
    canCurate: boolean;
}

/** Whether this view may change an item that can be shared to an Organization. */
export function canChangeItem({
    view,
    isOwn,
    shared,
    isOrgAccount,
    canCurate,
}: ItemChangePermission): boolean {
    if (view === "org") return isOrgAccount || canCurate;
    return isOwn && !shared;
}
