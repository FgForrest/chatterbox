"use client";

import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { ActionTooltip } from "@/components/ui/tooltip";
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
    collapsed?: boolean;
    onCollapse?: () => void;
    collapseLabel?: string;
    expandLabel?: string;
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

/** Return the scroll behavior that respects the reduced-motion preference. */
export function workflowScrollBehavior(): ScrollBehavior {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
}

function widgetHeading(id: string): HTMLElement | undefined {
    return [
        ...document.querySelectorAll<HTMLElement>(
            "[data-workflow-widget-heading]",
        ),
    ].find((heading) => heading.dataset.workflowWidgetHeading === id);
}

function focusWidgetHeading(id: string): void {
    widgetHeading(id)?.focus({ preventScroll: true });
}

/** Open a workflow widget, then scroll to its rendered frame and focus its heading. */
export function openWidget(id: string, source?: string): void {
    flushSync(() => {
        window.dispatchEvent(
            new CustomEvent(OPEN_WORKFLOW_WIDGET_EVENT, {
                detail: { id, ...(source ? { source } : {}) },
            }),
        );
    });
    const heading = widgetHeading(id);
    if (!heading?.closest('[role="dialog"]')) {
        const host = document.getElementById(id);
        const target =
            host && getComputedStyle(host).display === "contents"
                ? host.firstElementChild
                : host;
        target?.scrollIntoView?.({
            behavior: workflowScrollBehavior(),
            block: "start",
        });
    }
    heading?.focus({ preventScroll: true });
}

/** Listen for the shared workflow-widget open event for one widget id. */
export function useWorkflowWidgetOpen(
    id: string | undefined,
    onOpen?: (source?: string) => void,
): void {
    const openRef = useRef(onOpen);
    openRef.current = onOpen;
    useEffect(() => {
        if (!id) return;
        const handleOpen = (event: Event) => {
            const detail = (
                event as CustomEvent<{ id?: unknown; source?: unknown }>
            ).detail;
            if (detail?.id !== id) return;
            if (typeof detail.source === "string")
                openRef.current?.(detail.source);
            else openRef.current?.();
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
    collapsed,
    onCollapse,
    collapseLabel,
    expandLabel,
}: Pick<
    WorkflowWidgetProps,
    | "id"
    | "frame"
    | "title"
    | "helpLink"
    | "description"
    | "headerAction"
    | "collapsed"
    | "onCollapse"
    | "collapseLabel"
    | "expandLabel"
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
                className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap font-semibold"
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
            <div className="flex min-w-0 items-center justify-between gap-1 sm:gap-3">
                <div className="flex min-w-0 items-center gap-1">
                    {frame === "inline" && onCollapse && (
                        <ActionTooltip
                            label={
                                (collapsed ? expandLabel : collapseLabel) ?? ""
                            }
                        >
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-expanded={!collapsed}
                                aria-label={
                                    collapsed ? expandLabel : collapseLabel
                                }
                                onClick={onCollapse}
                            >
                                {collapsed ? (
                                    <ChevronDown className="size-4" />
                                ) : (
                                    <ChevronUp className="size-4" />
                                )}
                            </Button>
                        </ActionTooltip>
                    )}
                    {titleNode}
                </div>
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
            <WidgetHeader
                {...props}
                description={props.collapsed ? undefined : props.description}
            />
            <div
                hidden={props.collapsed}
                className={props.collapsed ? "hidden" : "contents"}
            >
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
            </div>
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
    const handleOpen = useCallback(() => onOpenChange?.(true), [onOpenChange]);
    useWorkflowWidgetOpen(id, handleOpen);
    useEffect(() => {
        if (!open) return;
        window.requestAnimationFrame(() => focusWidgetHeading(id));
    }, [id, open]);

    if (frame === "inline") {
        return (
            <>
                <span
                    id={inlineLine ? id : undefined}
                    className="contents"
                    data-workflow-widget={inlineLine ? true : undefined}
                    data-tone={inlineLine ? tone : undefined}
                >
                    {inlineLine}
                </span>
                <Card
                    hidden={Boolean(inlineLine)}
                    id={inlineLine ? undefined : id}
                    hasNoPadding
                    className={cn(
                        "@container/workflow gap-0 border-l-2 shadow-none",
                        toneClasses[tone],
                        inlineLine && "hidden",
                    )}
                    data-workflow-widget
                    data-tone={tone}
                >
                    <WidgetContents {...props} />
                </Card>
            </>
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
    const label = expanded && collapseLabel ? collapseLabel : expandLabel;
    const expandControl =
        onExpand && label ? (
            <ActionTooltip label={label}>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label}
                    aria-expanded={expanded ?? false}
                    onClick={onExpand}
                >
                    {expanded ? (
                        <ChevronUp className="size-4" />
                    ) : (
                        <ChevronDown className="size-4" />
                    )}
                </Button>
            </ActionTooltip>
        ) : null;
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
                {expandControl}
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
                {action}
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
