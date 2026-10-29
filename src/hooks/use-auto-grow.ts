"use client";

import { useEffect, useRef } from "react";

/** Size a textarea to its content within its CSS minimum and maximum heights. */
export function useAutoGrow(value: string, enabled = true) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const sized = useRef(false);

    // biome-ignore lint/correctness/useExhaustiveDependencies: the field is remeasured whenever its text changes.
    useEffect(() => {
        const field = ref.current;
        if (!field) return;
        if (!enabled) {
            if (sized.current) field.style.height = "";
            sized.current = false;
            return;
        }

        const resize = () => {
            const borderHeight = field.offsetHeight - field.clientHeight;
            field.style.height = "0px";
            field.style.height = `${field.scrollHeight + borderHeight}px`;
            sized.current = true;
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
        field.addEventListener("input", resize);
        return () => {
            observer?.disconnect();
            field.removeEventListener("input", resize);
        };
    }, [value, enabled]);

    return ref;
}
