"use client";

import {
    ArrowLeft,
    BadgeCheck,
    Download,
    FileCode2,
    Loader2,
    Paperclip,
    ShieldAlert,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ItemHeader } from "@/components/items/item-header";
import { MailLearnCard } from "@/components/mail/mail-learn-card";
import { MailSummaryCard } from "@/components/mail/mail-summary-card";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";
import type { CreatedFolder } from "@/components/pipeline/new-folder-form";
import {
    openWidget,
    WorkflowWidget,
} from "@/components/pipeline/workflow-widget";
import { ItemEraseMenu } from "@/components/recordings/erase-recording-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/format-bytes";
import { formatDateTime } from "@/lib/format-date";
import type { MailDetail, MailParticipantView } from "@/lib/mail/detail";
import { mailHtmlDocument } from "@/lib/mail/mail-html-document";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";
import { deriveWorkflowWidgets } from "@/lib/pipeline/workflow-widgets";
import { canChangeItem } from "@/lib/sharing/change-permission";
import { cn } from "@/lib/utils";
import type { DateTimeFormat } from "@/types/common";
import type {
    RecordingFolder,
    RecordingFolderAssignment,
} from "@/types/folder";
import type { Recording } from "@/types/recording";

interface Props {
    mail: Recording;
    itemLinkQuery?: string;
    /** The private item has been shared into the Organization. */
    shared?: boolean;
    dateTimeFormat: DateTimeFormat;
    onBackToList: () => void;
    backLabel?: string;
    hiddenOnMobile: boolean;
    /** The mail was deleted or shared: reload the pile. */
    onChanged: () => void;
    onFolderCreated?: (folder: CreatedFolder) => void;
    folders: RecordingFolder[];
    folderAssignments: RecordingFolderAssignment[];
    onSelectFolder: (folder: RecordingFolder) => void;
    onAddToFolder: (itemId: string, folderId: string) => Promise<void>;
    onRemoveFromFolder: (
        itemId: string,
        folderId: string,
        withdraw?: boolean,
    ) => Promise<void>;
    onMoveBetweenFolders: (
        itemId: string,
        fromFolderId: string,
        toFolderId: string,
    ) => Promise<void>;
    /** The organization account, which may take shared mail out. */
    isOrgAccount?: boolean;
    /** The viewer changes the Organization's content (a curator). */
    canCurate?: boolean;
}

type MailDetailResponse = MailDetail & {
    processing: ItemProcessingPresentation | null;
};

function person(participant: MailParticipantView): string {
    if (participant.name && participant.address) {
        return `${participant.name} <${participant.address}>`;
    }
    return participant.name ?? participant.address ?? "";
}

function withRole(
    participants: readonly MailParticipantView[],
    role: string,
): MailParticipantView[] {
    return participants.filter((participant) =>
        participant.roles.includes(role),
    );
}

function evidenceRange(params: URLSearchParams) {
    const segmentIndex = Number(params.get("evidenceSegment"));
    const charStart = Number(params.get("evidenceStart"));
    const charEnd = Number(params.get("evidenceEnd"));
    if (
        !Number.isInteger(segmentIndex) ||
        !Number.isInteger(charStart) ||
        !Number.isInteger(charEnd) ||
        charStart < 0 ||
        charEnd <= charStart
    ) {
        return null;
    }
    return { segmentIndex, charStart, charEnd };
}

/**
 * A mail in the Chatter pile: who it is from and to, its own text, its
 * signature, the quoted and forwarded messages (folded), attachments as
 * downloads only, and, on request, its formatted HTML in a sandboxed frame
 * that can run nothing and fetch nothing. A mail shared into the
 * Organization reads the same for everyone, who cannot delete it.
 */
export function MailDetailPane({
    mail,
    itemLinkQuery,
    shared = false,
    dateTimeFormat,
    onBackToList,
    backLabel,
    hiddenOnMobile,
    onChanged,
    onFolderCreated,
    folders,
    folderAssignments,
    onSelectFolder,
    onAddToFolder,
    onRemoveFromFolder,
    onMoveBetweenFolders,
    isOrgAccount = false,
    canCurate = false,
}: Props) {
    const i18n = useExtracted();
    const searchParams = useSearchParams();
    const locale = useLocale();
    const [detail, setDetail] = useState<MailDetailResponse | null>(null);
    const [processing, setProcessing] =
        useState<ItemProcessingPresentation | null>(null);
    const [failed, setFailed] = useState(false);
    const [formatted, setFormatted] = useState<string | null>(null);
    const [showFormatted, setShowFormatted] = useState(false);
    const [title, setTitle] = useState(mail.filename);
    const highlightQuery = itemLinkQuery ?? searchParams.toString();
    const highlight = useMemo(() => {
        const params = new URLSearchParams(highlightQuery);
        return params.get("recording") === mail.id
            ? evidenceRange(params)
            : null;
    }, [highlightQuery, mail.id]);

    useEffect(() => {
        setTitle(mail.filename);
    }, [mail.filename]);

    useEffect(() => {
        if (!detail || !highlight) return;
        document
            .getElementById("mail-evidence-highlight")
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [detail, highlight]);

    useEffect(() => {
        const controller = new AbortController();
        setDetail(null);
        setProcessing(null);
        setFailed(false);
        setFormatted(null);
        setShowFormatted(false);
        fetch(`/api/mail/${encodeURIComponent(mail.id)}`, {
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(String(response.status));
                const body = (await response.json()) as MailDetailResponse;
                setDetail(body);
                setProcessing(body.processing);
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    console.error("[mail] could not load the mail:", error);
                    setFailed(true);
                }
            });
        return () => controller.abort();
    }, [mail.id]);

    const toggleFormatted = useCallback(async () => {
        if (showFormatted) {
            setShowFormatted(false);
            return;
        }
        if (formatted === null) {
            const response = await fetch(
                `/api/mail/${encodeURIComponent(mail.id)}/html`,
            );
            const body = (await response.json().catch(() => ({}))) as {
                html?: string | null;
            };
            if (!response.ok || !body.html) {
                toast.error(i18n("This mail has no formatted version."));
                return;
            }
            const framed = mailHtmlDocument(body.html);
            if (framed === null) {
                toast.error(
                    i18n("This browser cannot show the mail formatted."),
                );
                return;
            }
            setFormatted(framed);
        }
        setShowFormatted(true);
    }, [formatted, i18n, mail.id, showFormatted]);

    const remove = useCallback(async () => {
        const response = await fetch(
            `/api/mail/${encodeURIComponent(mail.id)}`,
            { method: "DELETE" },
        );
        if (!response.ok) {
            throw new Error(i18n("The mail could not be deleted."));
        }
    }, [i18n, mail.id]);

    const isOwn = mail.isOwn !== false;
    const from = detail ? withRole(detail.participants, "from")[0] : undefined;
    const sender = detail
        ? withRole(detail.participants, "sender")[0]
        : undefined;
    const to = detail ? withRole(detail.participants, "to") : [];
    const cc = detail ? withRole(detail.participants, "cc") : [];
    const byRef = new Map(
        (detail?.participants ?? []).map((participant) => [
            participant.ref,
            participant,
        ]),
    );
    const widgets = processing ? deriveWorkflowWidgets(processing) : null;
    const canChange = canChangeItem({
        view: mail.view === "org" ? "org" : "private",
        isOwn,
        shared,
        isOrgAccount,
        canCurate,
    });
    const metadata = [
        mail.mail?.from ?? i18n("Unknown sender"),
        formatDateTime(
            detail?.sentAt ?? detail?.receivedAt ?? mail.startTime,
            dateTimeFormat,
            locale,
        ),
        formatBytes(detail?.sizeBytes ?? mail.filesize),
    ];
    const retentionNotes = detail
        ? [
              detail.rawReapedAt
                  ? i18n(
                        "The message as it arrived and its attachments were removed on {date}.",
                        {
                            date: formatDateTime(
                                detail.rawReapedAt,
                                "absolute",
                                locale,
                            ),
                        },
                    )
                  : null,
              detail.contentReapedAt
                  ? i18n("Its text was removed on {date}.", {
                        date: formatDateTime(
                            detail.contentReapedAt,
                            "absolute",
                            locale,
                        ),
                    })
                  : null,
              detail.summaryReapedAt
                  ? i18n("Its summary was removed on {date}.", {
                        date: formatDateTime(
                            detail.summaryReapedAt,
                            "absolute",
                            locale,
                        ),
                    })
                  : null,
          ].filter((note): note is string => note !== null)
        : [];

    return (
        <div
            className={cn(
                "min-w-0 space-y-6 lg:block lg:self-start",
                hiddenOnMobile && "hidden",
            )}
        >
            <Button
                variant="ghost"
                size="sm"
                onClick={onBackToList}
                className="-ml-2 h-9 gap-1 px-2 lg:hidden"
            >
                <ArrowLeft className="size-4" /> {backLabel ?? i18n("Recent")}
            </Button>
            <ItemHeader
                itemId={mail.id}
                kind="mail"
                title={title || i18n("(no subject)")}
                metadata={metadata}
                view={mail.view}
                shared={shared}
                isOwn={isOwn}
                ownerName={mail.ownerName}
                readOnly={!canChange}
                onRenamed={(renamed) => {
                    setTitle(renamed);
                    onChanged();
                }}
                action={
                    isOwn && mail.view !== "org" ? (
                        <ItemEraseMenu
                            recording={{ ...mail, filename: title }}
                            shared={shared}
                            onDeleteMail={remove}
                            onChanged={onChanged}
                        />
                    ) : undefined
                }
                retentionNotes={retentionNotes}
            />
            <ItemWorkflow
                itemId={mail.id}
                kind="mail"
                initialData={processing}
                onProcessingChange={setProcessing}
                folders={folders}
                folderAssignments={folderAssignments}
                onSelectFolder={onSelectFolder}
                onAddToFolder={onAddToFolder}
                onRemoveFromFolder={onRemoveFromFolder}
                onMoveBetweenFolders={onMoveBetweenFolders}
                isOwn={isOwn}
                canWithdraw={isOwn || (mail.view === "org" && isOrgAccount)}
                view={mail.view === "org" ? "org" : "private"}
                onLearn={() => openWidget(`mail-learn-${mail.id}`)}
                onSummary={() => openWidget(`mail-summary-${mail.id}`)}
                onReviewLearn={() => openWidget(`mail-learn-${mail.id}`)}
                onReviewTasks={() => openWidget(`mail-task-review-${mail.id}`)}
                onChanged={onChanged}
                onFolderCreated={onFolderCreated}
            />
            <div className="space-y-3 border-y px-4 py-3 sm:px-6">
                {failed && (
                    <p className="text-sm text-destructive">
                        {i18n("The mail could not be loaded.")}
                    </p>
                )}
                {!detail && !failed && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        {i18n("Loading…")}
                    </div>
                )}
                {detail && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">
                            {i18n("From")}
                        </dt>
                        <dd className="flex flex-wrap items-center gap-1.5 break-all">
                            {from ? person(from) : "—"}
                            {detail.senderVerified ? (
                                <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                                    <BadgeCheck className="size-3.5" />
                                    {i18n("Verified")}
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                                    <ShieldAlert className="size-3.5" />
                                    {i18n("Sender not verified")}
                                </span>
                            )}
                        </dd>
                        {sender && (
                            <>
                                <dt className="text-muted-foreground">
                                    {i18n("Sent by")}
                                </dt>
                                <dd className="break-all">{person(sender)}</dd>
                            </>
                        )}
                        {to.length > 0 && (
                            <>
                                <dt className="text-muted-foreground">
                                    {i18n("To")}
                                </dt>
                                <dd className="break-all">
                                    {to.map(person).join(", ")}
                                </dd>
                            </>
                        )}
                        {cc.length > 0 && (
                            <>
                                <dt className="text-muted-foreground">
                                    {i18n("Cc")}
                                </dt>
                                <dd className="break-all">
                                    {cc.map(person).join(", ")}
                                </dd>
                            </>
                        )}
                        <dt className="text-muted-foreground">
                            {i18n("Date")}
                        </dt>
                        <dd>
                            {formatDateTime(
                                detail.sentAt ?? detail.receivedAt,
                                dateTimeFormat,
                                locale,
                            )}
                        </dd>
                    </dl>
                )}
                {detail?.autoGenerated && (
                    <p className="text-xs text-muted-foreground">
                        {i18n(
                            "Sent by a machine (an auto-reply, a list, a notice): kept, never summarized.",
                        )}
                    </p>
                )}
                {detail?.unreadable && !detail.rawReapedAt && (
                    <p className="text-sm text-muted-foreground">
                        {i18n(
                            "This mail's content is not readable here (encrypted or packed). Download the message to open it.",
                        )}
                    </p>
                )}
            </div>

            {detail &&
                detail.segments.length > 0 &&
                (!widgets || widgets.message.visible) && (
                    <WorkflowWidget
                        id={`mail-message-${mail.id}`}
                        frame="inline"
                        tone={widgets?.message.active ? "next" : "quiet"}
                        title={i18n("Message")}
                        headerAction={
                            <div className="flex items-center gap-1">
                                {isOwn && detail.hasRaw && (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                asChild
                                            >
                                                <a
                                                    href={`/api/mail/${encodeURIComponent(mail.id)}/raw`}
                                                    download
                                                    rel="nofollow noreferrer"
                                                    aria-label={i18n(
                                                        "Download the message",
                                                    )}
                                                >
                                                    <Download className="size-4" />
                                                </a>
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                            {i18n("Download the message")}
                                        </TooltipContent>
                                    </Tooltip>
                                )}
                                {!detail.rawReapedAt && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 gap-1 px-2 text-xs"
                                        aria-pressed={showFormatted}
                                        onClick={() => void toggleFormatted()}
                                    >
                                        <FileCode2 className="size-3.5" />
                                        {showFormatted
                                            ? i18n("Show text")
                                            : i18n("Show formatted")}
                                    </Button>
                                )}
                            </div>
                        }
                    >
                        <div className="space-y-3">
                            {showFormatted && formatted ? (
                                <iframe
                                    title={i18n("Formatted mail")}
                                    sandbox=""
                                    srcDoc={formatted}
                                    referrerPolicy="no-referrer"
                                    className="h-[70vh] w-full rounded border bg-white"
                                />
                            ) : (
                                detail.segments.map((segment) => {
                                    const author = segment.participantRef
                                        ? byRef.get(segment.participantRef)
                                        : undefined;
                                    const range =
                                        highlight?.segmentIndex ===
                                            segment.index &&
                                        highlight.charEnd <= segment.text.length
                                            ? highlight
                                            : null;
                                    const text = (
                                        <p className="whitespace-pre-wrap break-words text-sm">
                                            {range ? (
                                                <>
                                                    {segment.text.slice(
                                                        0,
                                                        range.charStart,
                                                    )}
                                                    <mark
                                                        id="mail-evidence-highlight"
                                                        className="rounded bg-amber-200 px-0.5 text-inherit dark:bg-amber-700"
                                                    >
                                                        {segment.text.slice(
                                                            range.charStart,
                                                            range.charEnd,
                                                        )}
                                                    </mark>
                                                    {segment.text.slice(
                                                        range.charEnd,
                                                    )}
                                                </>
                                            ) : (
                                                segment.text
                                            )}
                                        </p>
                                    );
                                    if (segment.role === "body") {
                                        return (
                                            <div key={segment.index}>
                                                {text}
                                            </div>
                                        );
                                    }
                                    if (segment.role === "signature") {
                                        return (
                                            <div
                                                key={segment.index}
                                                className="border-l-2 pl-3 text-muted-foreground [&_p]:text-xs"
                                            >
                                                {text}
                                            </div>
                                        );
                                    }
                                    const label =
                                        segment.role === "disclaimer"
                                            ? i18n("Disclaimer")
                                            : segment.role ===
                                                "quoted_signature"
                                              ? i18n("Signature of {name}", {
                                                    name: author
                                                        ? person(author)
                                                        : i18n(
                                                              "the quoted sender",
                                                          ),
                                                })
                                              : i18n("Quoted from {name}", {
                                                    name: author
                                                        ? person(author)
                                                        : i18n(
                                                              "an earlier message",
                                                          ),
                                                });
                                    return (
                                        <details
                                            key={segment.index}
                                            className="rounded border bg-muted/30 px-3 py-2"
                                            style={{
                                                marginLeft: `${Math.max(0, segment.depth - 1) * 12}px`,
                                            }}
                                            open={range ? true : undefined}
                                        >
                                            <summary className="cursor-pointer text-xs text-muted-foreground">
                                                {label}
                                                {segment.at &&
                                                    ` · ${formatDateTime(segment.at, dateTimeFormat, locale)}`}
                                            </summary>
                                            <div className="mt-2">{text}</div>
                                        </details>
                                    );
                                })
                            )}
                        </div>
                    </WorkflowWidget>
                )}

            {detail && (!widgets || widgets.learn.visible) && (
                <MailLearnCard
                    mail={mail}
                    detail={detail}
                    canChange={canChange}
                    widget={widgets?.learn}
                    widgetId={`mail-learn-${mail.id}`}
                />
            )}
            {detail &&
                !detail.unreadable &&
                (!widgets || widgets.summary.visible) && (
                    <MailSummaryCard
                        mail={mail}
                        detail={detail}
                        processing={processing}
                        canChange={canChange}
                        widget={widgets?.summary}
                        taskWidget={widgets?.taskReview}
                        workflowVisible={widgets?.workflowVisible ?? false}
                        profileName={processing?.profile?.name}
                        widgetId={`mail-summary-${mail.id}`}
                        taskWidgetId={`mail-task-review-${mail.id}`}
                    />
                )}

            {detail && detail.attachments.length > 0 && (
                <Card className="py-0">
                    <CardContent className="space-y-2 p-4 sm:p-6">
                        <h3 className="flex items-center gap-1.5 text-sm font-medium">
                            <Paperclip className="size-4" />
                            {i18n("Attachments")}
                        </h3>
                        <ul className="space-y-1 text-sm">
                            {detail.attachments.map((attachment) => {
                                const name =
                                    attachment.filename ??
                                    i18n("Attachment {n}", {
                                        n: String(attachment.index + 1),
                                    });
                                return (
                                    <li key={attachment.index}>
                                        {detail.rawReapedAt ? (
                                            <span>{name}</span>
                                        ) : (
                                            <a
                                                href={`/api/mail/${encodeURIComponent(mail.id)}/attachments/${attachment.index}`}
                                                download
                                                className="text-primary hover:underline"
                                            >
                                                {name}
                                            </a>
                                        )}{" "}
                                        <span className="text-xs text-muted-foreground">
                                            {formatBytes(attachment.size)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
