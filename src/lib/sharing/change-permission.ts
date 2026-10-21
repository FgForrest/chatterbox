interface ItemChangePermission {
    view: "private" | "org";
    isOwn: boolean;
    isOrgAccount: boolean;
    canCurate: boolean;
}

/** Whether this view may change an item that can be shared to an Organization. */
export function canChangeItem({
    view,
    isOwn,
    isOrgAccount,
    canCurate,
}: ItemChangePermission): boolean {
    if (view === "org") return isOwn || isOrgAccount || canCurate;
    return isOwn;
}
