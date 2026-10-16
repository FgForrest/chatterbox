"use client";

import { useExtracted } from "next-intl";

export function ProfilesSettingsLink() {
    const i18n = useExtracted();
    return (
        <p className="text-sm text-muted-foreground">
            {i18n("Processing choices are set in profiles.")}{" "}
            <a
                className="font-medium text-primary hover:underline"
                href="#profiles"
            >
                {i18n("Set in your profiles")}
            </a>
        </p>
    );
}
