"use client";

import { AlertTriangle, GraduationCap } from "lucide-react";
import { useExtracted } from "next-intl";
import type { ReactNode } from "react";
import { WorkflowWidgetLine } from "@/components/pipeline/workflow-widget";
import { Button } from "@/components/ui/button";
import type { WorkflowWidgetTone } from "@/lib/pipeline/workflow-widgets";

interface LearnWorkflowLineProps {
    id?: string;
    title: ReactNode;
    facts?: ReactNode;
    tone?: WorkflowWidgetTone;
    working?: boolean;
    finished?: boolean;
    failed?: boolean;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    onRetry?: () => void;
}

/** Shared Learn status line for recording and mail workflow widgets. */
export function LearnWorkflowLine({
    id,
    title,
    facts,
    tone,
    working = false,
    finished = false,
    failed = false,
    actionLabel,
    onAction,
    actionDisabled = false,
    onRetry,
}: LearnWorkflowLineProps) {
    const i18n = useExtracted();
    let action: ReactNode = null;
    if (!working && !finished && !failed && onAction) {
        action = (
            <Button
                type="button"
                size="sm"
                disabled={actionDisabled}
                onClick={onAction}
            >
                {actionLabel}
            </Button>
        );
    } else if (!working && onRetry) {
        action = (
            <Button type="button" size="sm" onClick={onRetry}>
                {i18n("Try again")}
            </Button>
        );
    }
    const collapsed = finished || failed;
    return (
        <WorkflowWidgetLine
            id={id}
            title={title}
            facts={facts}
            tone={tone}
            working={working}
            icon={
                failed ? (
                    <AlertTriangle className="size-4 text-destructive" />
                ) : (
                    <GraduationCap className="size-4" />
                )
            }
            action={action}
            expanded={collapsed && onAction ? false : undefined}
            onExpand={collapsed ? onAction : undefined}
            expandLabel={collapsed ? actionLabel : undefined}
            onOpen={onAction}
        />
    );
}
