"use client";

import { useEffect, useRef } from "react";

export interface GroupToggle {
    state: "all" | "some" | "none";
    disabled: boolean;
    label: string;
    onToggle: () => void;
}

/** Ticks or unticks a whole section; half-ticked when only some are selected. */
export function GroupCheckbox({
    state,
    disabled,
    label,
    onToggle,
}: GroupToggle) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = state === "some";
    }, [state]);
    return (
        <input
            ref={ref}
            type="checkbox"
            className="size-4 shrink-0"
            checked={state === "all"}
            disabled={disabled}
            aria-label={label}
            title={label}
            onChange={onToggle}
        />
    );
}
