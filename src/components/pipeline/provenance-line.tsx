import type { ReactNode } from "react";

/** Ordered footer facts separated by decorative dots, with falsy content omitted. */
export function ProvenanceLine({
    items,
    "data-testid": testId,
}: {
    items: readonly { key: string; content: ReactNode }[];
    "data-testid"?: string;
}) {
    return (
        <div
            data-testid={testId}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
            {items
                .filter(({ content }) => Boolean(content))
                .map(({ key, content }, index) => (
                    <span key={key} className="inline-flex items-center gap-2">
                        {index > 0 && <span aria-hidden="true">·</span>}
                        {content}
                    </span>
                ))}
        </div>
    );
}
