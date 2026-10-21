"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import { folderDisplayName, type LabelledFolder } from "@/lib/folders/labels";

/** Display name of a folder in the current UI language. */
export function useFolderLabel() {
    const i18n = useExtracted();
    const privateLabel = i18n("Private");
    const organizationLabel = i18n("Organization");
    return useCallback(
        (folder: LabelledFolder) =>
            folderDisplayName(folder, {
                private: privateLabel,
                organization: organizationLabel,
            }),
        [privateLabel, organizationLabel],
    );
}
