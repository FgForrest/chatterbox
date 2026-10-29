import type { ReactNode } from "react";

/** A count immediately following a block heading. */
export function HeadingCount({ children }: { children: ReactNode }) {
    return (
        <span
            data-slot="heading-count"
            className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground"
        >
            {children}
        </span>
    );
}
