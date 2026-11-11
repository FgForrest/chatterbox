"use client";

import { createContext, type ReactNode, useContext } from "react";

const RestrictedFolderContext = createContext({ writable: false, userId: "" });

/** Deployment authority for restricted-folder writes, supplied by the server. */
export function RestrictedFolderProvider({
    writable,
    userId,
    children,
}: {
    writable: boolean;
    userId: string;
    children: ReactNode;
}) {
    return (
        <RestrictedFolderContext.Provider value={{ writable, userId }}>
            {children}
        </RestrictedFolderContext.Provider>
    );
}

export function useRestrictedFolders() {
    return useContext(RestrictedFolderContext);
}
