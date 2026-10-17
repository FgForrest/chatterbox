"use client";

import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import type {
    WorkflowWidgetFrame,
    WorkflowWidgetTone,
} from "@/lib/pipeline/workflow-widgets";
import { cn } from "@/lib/utils";

/** The DOM event dispatched when a workflow widget should open and focus. */
export const OPEN_WORKFLOW_WIDGET_EVENT = "riffado:open-workflow-widget";

const toneClasses: Record<WorkflowWidgetTone, string> = {
    quiet: "border-l-border",
    next: "border-l-primary",
    review: "border-l-[var(--step-review)]",
    working: "border-l-[var(--step-working)]",
};

const dialogWidthClasses = {
    md: "sm:max-w-xl",
    lg: "sm:max-w-2xl",
    xl: "sm:max-w-3xl",
    "2xl": "sm:max-w-2xl lg:max-w-5xl",
    "3xl": "sm:max-w-2xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl",
} as const;

type DialogWidth = keyof typeof dialogWidthClasses;

/** Shared footer content rendered by either workflow-widget frame. */
export interface WorkflowWidgetFooter {
    status?: ReactNode;
    actions: ReactNode;
}

/** Content and frame controls for a workflow widget. */
export interface WorkflowWidgetProps {
    id: string;
    frame: WorkflowWidgetFrame;
    tone: WorkflowWidgetTone;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    title: ReactNode;
    helpLink?: ReactNode;
    description?: ReactNode;
    headerAction?: ReactNode;
    children?: ReactNode;
    footer?: WorkflowWidgetFooter;
    closeLabel?: string;
    dialogWidth?: DialogWidth;
    dialogLine?: ReactNode;
    inlineLine?: ReactNode;
    bodyClassName?: string;
}

/** Content and controls for a compact workflow status line. */
export interface WorkflowWidgetLineProps {
    id?: string;
    title: ReactNode;
    facts?: ReactNode;
    icon?: ReactNode;
    tone?: WorkflowWidgetTone;
    working?: boolean;
    action?: ReactNode;
    expanded?: boolean;
    onExpand?: () => void;
    expandLabel?: string;
    collapseLabel?: string;
    onOpen?: () => void;
}

/** Content and controls for a compact workflow step that is ready to start. */
export interface WorkflowWidgetRunLineProps
    extends Omit<
        WorkflowWidgetLineProps,
        | "working"
        | "action"
        | "expanded"
        | "onExpand"
        | "expandLabel"
        | "collapseLabel"
        | "onOpen"
    > {
    runLabel: ReactNode;
    onRun: () => void;
    disabled?: boolean;
}

/** Return the shared attributes used to identify a workflow widget heading. */
export function workflowWidgetHeadingProps(id: string | undefined) {
    return {
        "data-workflow-widget-heading": id,
        tabIndex: -1,
    } as const;
}

function focusWidgetHeading(id: string): void {
    for (const heading of document.querySelectorAll<HTMLElement>(
        "[data-workflow-widget-heading]",
    )) {
        if (heading.dataset.workflowWidgetHeading === id) {
            heading.focus({ preventScroll: true });
            return;
        }
    }
}

/** Scroll to a workflow widget and ask its shared frame to open and focus. */
export function openWidget(id: string): void {
    const target = document.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.dispatchEvent(
        new CustomEvent(OPEN_WORKFLOW_WIDGET_EVENT, { detail: { id } }),
    );
}

/** Listen for the shared workflow-widget open event for one widget id. */
export function useWorkflowWidgetOpen(
    id: string | undefined,
    onOpen?: () => void,
): void {
    const openRef = useRef(onOpen);
    openRef.current = onOpen;
    useEffect(() => {
        if (!id) return;
        const handleOpen = (event: Event) => {
            const detail = (event as CustomEvent<{ id?: unknown }>).detail;
            if (detail?.id !== id) return;
            openRef.current?.();
            window.requestAnimationFrame(() => focusWidgetHeading(id));
        };
        window.addEventListener(OPEN_WORKFLOW_WIDGET_EVENT, handleOpen);
        return () =>
            window.removeEventListener(OPEN_WORKFLOW_WIDGET_EVENT, handleOpen);
    }, [id]);
}

function WidgetHeader({
    id,
    frame,
    title,
    helpLink,
    description,
    headerAction,
}: Pick<
    WorkflowWidgetProps,
    "id" | "frame" | "title" | "helpLink" | "description" | "headerAction"
>) {
    const heading = (
        <>
            {title}
            {helpLink}
        </>
    );
    let titleNode: ReactNode;
    if (frame === "dialog") {
        titleNode = (
            <DialogTitle
                {...workflowWidgetHeadingProps(id)}
                className="flex min-w-0 items-center gap-2 text-base"
            >
                {heading}
            </DialogTitle>
        );
    } else {
        titleNode = (
            <h2
                {...workflowWidgetHeadingProps(id)}
                className="flex min-w-0 items-center gap-2 font-semibold"
            >
                {heading}
            </h2>
        );
    }
    let descriptionNode: ReactNode = null;
    if (description && frame === "dialog") {
        descriptionNode = <DialogDescription>{description}</DialogDescription>;
    } else if (description) {
        descriptionNode = (
            <p className="text-sm text-muted-foreground">{description}</p>
        );
    }
    return (
        <header className="border-b px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-start justify-between gap-3">
                {titleNode}
                {headerAction && <div className="shrink-0">{headerAction}</div>}
            </div>
            {descriptionNode && <div className="mt-1">{descriptionNode}</div>}
        </header>
    );
}

function WidgetFooter({
    footer,
    closeLabel,
    frame,
}: {
    footer: WorkflowWidgetFooter;
    closeLabel?: string;
    frame: WorkflowWidgetFrame;
}) {
    return (
        <footer className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="min-w-0 flex-1 text-sm text-muted-foreground">
                {footer.status}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
                {frame === "dialog" && closeLabel && (
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            {closeLabel}
                        </Button>
                    </DialogClose>
                )}
                {footer.actions}
            </div>
        </footer>
    );
}

function WidgetContents(props: WorkflowWidgetProps) {
    return (
        <>
            <WidgetHeader {...props} />
            {props.children && (
                <div
                    className={cn(
                        "min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6",
                        props.bodyClassName,
                    )}
                    data-widget-body
                >
                    {props.children}
                </div>
            )}
            {props.footer && (
                <WidgetFooter
                    footer={props.footer}
                    closeLabel={props.closeLabel}
                    frame={props.frame}
                />
            )}
        </>
    );
}

/** Render one workflow body in either its inline card or dialog frame. */
export function WorkflowWidget(props: WorkflowWidgetProps) {
    const {
        id,
        frame,
        tone,
        open = false,
        onOpenChange,
        dialogWidth = "xl",
        dialogLine,
        inlineLine,
    } = props;
    const openDialog = useCallback(() => onOpenChange?.(true), [onOpenChange]);
    useWorkflowWidgetOpen(id, frame === "dialog" ? openDialog : undefined);
    useEffect(() => {
        if (!open) return;
        window.requestAnimationFrame(() => focusWidgetHeading(id));
    }, [id, open]);

    if (frame === "inline") {
        if (inlineLine) {
            return (
                <span
                    id={id}
                    className="contents"
                    data-workflow-widget
                    data-tone={tone}
                >
                    {inlineLine}
                </span>
            );
        }
        return (
            <Card
                id={id}
                hasNoPadding
                className={cn(
                    "gap-0 border-l-2 shadow-none",
                    toneClasses[tone],
                )}
                data-workflow-widget
                data-tone={tone}
            >
                <WidgetContents {...props} />
            </Card>
        );
    }
    return (
        <span
            id={id}
            className="contents"
            data-workflow-widget
            data-tone={tone}
        >
            {dialogLine}
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    className={cn(
                        "flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0",
                        dialogWidthClasses[dialogWidth],
                    )}
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        focusWidgetHeading(id);
                    }}
                >
                    <WidgetContents {...props} />
                </DialogContent>
            </Dialog>
        </span>
    );
}

/** Render a finished, ready, or working workflow step as one compact row. */
export function WorkflowWidgetLine({
    id,
    title,
    facts,
    icon,
    tone = "quiet",
    working = false,
    action,
    expanded,
    onExpand,
    expandLabel,
    collapseLabel,
    onOpen,
}: WorkflowWidgetLineProps) {
    useWorkflowWidgetOpen(id, onOpen);
    let control = action;
    if (onExpand && expandLabel) {
        const label = expanded && collapseLabel ? collapseLabel : expandLabel;
        const expandControl = (
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                aria-expanded={expanded ?? false}
                onClick={onExpand}
            >
                {expanded ? (
                    <ChevronUp className="size-4" />
                ) : (
                    <ChevronDown className="size-4" />
                )}
                {label}
            </Button>
        );
        control = action ? (
            <div className="flex shrink-0 items-center gap-2">
                {expandControl}
                {action}
            </div>
        ) : (
            expandControl
        );
    }
    return (
        <Card
            id={id}
            hasNoPadding
            className={cn(
                "min-h-14 gap-0 border-l-2 shadow-none",
                toneClasses[tone],
            )}
            data-workflow-widget-line
            data-tone={tone}
        >
            <div className="flex min-h-14 min-w-0 items-center gap-3 px-4 py-2">
                {working ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
                ) : (
                    icon
                )}
                <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
                    <h2
                        {...workflowWidgetHeadingProps(id)}
                        className="shrink-0 font-medium"
                    >
                        {title}
                    </h2>
                    {facts && (
                        <span className="truncate text-sm text-muted-foreground">
                            {facts}
                        </span>
                    )}
                </div>
                {control}
            </div>
        </Card>
    );
}

/** Render a compact ready step with one action that starts and opens it. */
export function WorkflowWidgetRunLine({
    runLabel,
    onRun,
    disabled = false,
    ...lineProps
}: WorkflowWidgetRunLineProps) {
    return (
        <WorkflowWidgetLine
            {...lineProps}
            action={
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={onRun}
                >
                    {runLabel}
                </Button>
            }
            onOpen={onRun}
        />
    );
}
