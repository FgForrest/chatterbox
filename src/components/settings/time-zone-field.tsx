"use client";

import { useExtracted } from "next-intl";
import { SearchCombobox } from "@/components/ui/search-combobox";

/** Shared user and Organization time zone picker. */
export function TimeZoneField({
    value,
    onChange,
    organization = false,
    disabled = false,
}: {
    value: string | null;
    onChange: (value: string | null) => void;
    organization?: boolean;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    const zones = [
        ...new Set([
            "UTC",
            ...Intl.supportedValuesOf("timeZone"),
            ...(value ? [value] : []),
        ]),
    ].sort();
    return (
        <SearchCombobox
            aria-label={
                organization
                    ? i18n("Organization time zone")
                    : i18n("Time zone")
            }
            value={value ?? "auto"}
            onValueChange={(value) => onChange(value === "auto" ? null : value)}
            disabled={disabled}
            options={[
                {
                    value: "auto",
                    label: organization
                        ? i18n("No default (UTC)")
                        : i18n("Automatic (from your browser)"),
                    alwaysVisible: true,
                },
                ...zones.map((zone) => ({ value: zone, label: zone })),
            ]}
        />
    );
}
