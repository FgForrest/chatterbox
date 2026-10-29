"use client";

import { useEffect, useRef } from "react";

/** Size a textarea to its content within its CSS minimum and maximum heights. */
export function useAutoGrow(value: string) {
    const ref = useRef<HTMLTextAreaElement>(null);

    // biome-ignore lint/correctness/useExhaustiveDependencies: the field is remeasured whenever its text changes.
    useEffect(() => {
        const field = ref.current;
        if (!field) return;

        const resize = () => {
            const borderHeight = field.offsetHeight - field.clientHeight;
            field.style.height = "0px";
            field.style.height = `${field.scrollHeight + borderHeight}px`;
        };
        resize();
        let width = field.clientWidth;
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      if (width === field.clientWidth) return;
                      width = field.clientWidth;
                      resize();
                  });
        observer?.observe(field);
        return () => observer?.disconnect();
    }, [value]);

    return ref;
}
