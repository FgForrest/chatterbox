"use client";

import {
    type ComponentProps,
    cloneElement,
    type ReactElement,
    type RefObject,
    useId,
    useLayoutEffect,
    useState,
} from "react";
import { cn } from "@/lib/utils";
import { LinkedText } from "./linked-text";

function clickedOffset(
    root: HTMLElement,
    x: number,
    y: number,
    fallback: number,
) {
    const doc = root.ownerDocument as Document & {
        caretPositionFromPoint?: (
            x: number,
            y: number,
        ) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caret = doc.caretPositionFromPoint?.(x, y);
    const range = caret ? null : doc.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? range?.startContainer;
    const offset = caret?.offset ?? range?.startOffset;
    if (!node || offset === undefined || !root.contains(node)) return fallback;
    if (node === root && root.querySelector("[data-text-start]")) {
        const next = root.childNodes[offset];
        return next instanceof HTMLElement
            ? Number(next.dataset.textStart ?? fallback)
            : fallback;
    }
    const segment =
        node.parentElement?.closest<HTMLElement>("[data-text-start]") ?? root;
    if (!root.contains(segment)) return fallback;
    const prefix = doc.createRange();
    prefix.selectNodeContents(segment);
    prefix.setEnd(node, offset);
    return Number(segment.dataset.textStart ?? 0) + prefix.toString().length;
}

/** Keep a bound textarea mounted while showing clickable plain text outside editing. */
export function LinkedTextField({
    text,
    inputRef,
    children,
    className,
    displayClassName,
}: {
    text: string;
    inputRef: RefObject<HTMLTextAreaElement | null>;
    children: ReactElement<ComponentProps<"textarea">>;
    className?: string;
    displayClassName?: string;
}) {
    const id = useId();
    const [editing, setEditing] = useState(false);
    useLayoutEffect(() => {
        const input = inputRef.current;
        if (!editing || !input || input.value !== text) return;
        const resize = () => {
            if (input.ownerDocument.activeElement !== input) return;
            input.style.height = "0px";
            input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
        };
        resize();
        let width = input.clientWidth;
        const observer =
            typeof ResizeObserver === "undefined"
                ? null
                : new ResizeObserver(() => {
                      if (width === input.clientWidth) return;
                      width = input.clientWidth;
                      resize();
                  });
        observer?.observe(input);
        return () => observer?.disconnect();
    }, [editing, inputRef, text]);
    return (
        <div
            className={cn("relative flex min-w-0 flex-col", className)}
            onFocusCapture={(event) => {
                if (!inputRef.current?.isSameNode(event.target)) return;
                setEditing(true);
            }}
            onBlurCapture={(event) => {
                if (inputRef.current?.isSameNode(event.target))
                    setEditing(false);
            }}
        >
            {!editing && (
                <label
                    htmlFor={id}
                    onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            inputRef.current?.focus();
                        }
                    }}
                    className={cn(
                        "block cursor-text break-words whitespace-pre-wrap",
                        displayClassName,
                    )}
                    onClick={(event) => {
                        if (
                            event.target instanceof Element &&
                            event.target.closest("a")
                        )
                            return;
                        event.preventDefault();
                        const caret = clickedOffset(
                            event.currentTarget,
                            event.clientX,
                            event.clientY,
                            text.length,
                        );
                        const input = inputRef.current;
                        input?.focus();
                        input?.setSelectionRange(caret, caret);
                    }}
                >
                    {text ? (
                        <LinkedText text={text} />
                    ) : (
                        <span className="text-muted-foreground">
                            {children.props.placeholder}
                        </span>
                    )}
                </label>
            )}
            {cloneElement(children, {
                id,
                style: editing
                    ? children.props.style
                    : {
                          ...children.props.style,
                          position: "absolute",
                          width: 1,
                          height: 1,
                          minHeight: 0,
                          maxHeight: 1,
                          padding: 0,
                          border: 0,
                          overflow: "hidden",
                          clipPath: "inset(50%)",
                      },
            })}
        </div>
    );
}
