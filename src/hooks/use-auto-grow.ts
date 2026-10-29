"use client";

import { useEffect, useRef } from "react";

/** Size a textarea to its content within its CSS minimum and maximum heights. */
export function useAutoGrow(value: string, enabled = true) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const sized = useRef(false);
    const measured = useRef<string | null>(null);
    const resize = useRef<(() => void) | null>(null);

    useEffect(() => {
        const field = ref.current;
        if (!field) return;
        if (!enabled) {
            if (sized.current) field.style.height = "";
            sized.current = false;
            return;
        }

        const fit = () => {
            const borderHeight = field.offsetHeight - field.clientHeight;
            field.style.height = "0px";
            field.style.height = `${field.scrollHeight + borderHeight}px`;
            measured.current = field.value;
            sized.current = true;
        };
        resize.current = fit;
        fit();
        let width = field.clientWidth;
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      if (width === field.clientWidth) return;
                      width = field.clientWidth;
                      fit();
                  });
        observer?.observe(field);
        field.addEventListener("input", fit);
        return () => {
            resize.current = null;
            observer?.disconnect();
            field.removeEventListener("input", fit);
        };
    }, [enabled]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: a new value set without typing (a reset, a reload) is remeasured.
    useEffect(() => {
        // Typing already measured this text in the input listener.
        if (ref.current?.value !== measured.current) resize.current?.();
    }, [value]);

    return ref;
}
