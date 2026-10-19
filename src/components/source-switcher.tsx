"use client";

import { useExtracted } from "next-intl";

/** Switches between Plaud, custom, and mixed content sources. */
export function SourceSwitcher({
    ariaLabel,
    sources,
    value,
    onSelect,
}: {
    ariaLabel: string;
    sources: readonly string[];
    value: string;
    onSelect: (source: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <fieldset
            className="inline-flex shrink-0 rounded-lg bg-muted/70 p-1"
            aria-label={ariaLabel}
        >
            {sources.map((source) => (
                <button
                    key={source}
                    type="button"
                    onClick={() => onSelect(source)}
                    aria-pressed={source === value}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                        source === value
                            ? "bg-primary text-primary-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                    }`}
                >
                    {source === "plaud"
                        ? "Plaud"
                        : source === "mixed"
                          ? i18n("Mix")
                          : i18n("Custom")}
                </button>
            ))}
        </fieldset>
    );
}
