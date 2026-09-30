"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { ImportResult } from "@/lib/knowledge/import-list";

const EXAMPLE = `product: Alpha, Beta (Béta, B2)
organization: Acme
person: Jana Nováková (Janička)`;

/**
 * Import a pasted list of people and things: a preview says what each
 * name would do, and Import does it.
 */
export function ImportDialog({
    open,
    onOpenChange,
    typeLabels,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    typeLabels: Record<string, string>;
}) {
    const i18n = useExtracted();
    const router = useRouter();
    const [text, setText] = useState("");
    const [preview, setPreview] = useState<ImportResult | null>(null);
    const [busy, setBusy] = useState(false);

    async function send(dryRun: boolean): Promise<ImportResult | null> {
        setBusy(true);
        try {
            const response = await fetch("/api/knowledge/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, dryRun }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("Could not read this list"),
                    ),
                );
                return null;
            }
            return (await response.json()) as ImportResult;
        } finally {
            setBusy(false);
        }
    }

    async function apply() {
        const result = await send(false);
        if (!result) return;
        toast.success(
            i18n(
                "Imported: {created, plural, one {# record} other {# records}} added, {nicknames, plural, one {# nickname} other {# nicknames}} given",
                {
                    created: result.created,
                    nicknames: result.nicknamesAdded,
                },
            ),
        );
        setText("");
        setPreview(null);
        onOpenChange(false);
        router.refresh();
    }

    const statusText = (status: string, nicknames: number) => {
        switch (status) {
            case "create":
                return i18n("will be added");
            case "exists":
                return nicknames > 0
                    ? i18n("exists: nicknames added to it")
                    : i18n("exists already");
            case "unknown_type":
                return i18n("unknown type");
            case "ambiguous":
                return i18n(
                    "several people have this name: give nicknames on their page",
                );
            default:
                return i18n("name or nickname too long");
        }
    };
    const actionable = preview?.rows.some(
        (row) =>
            row.status === "create" ||
            (row.status === "exists" && row.nicknames.length > 0),
    );
    const unknownTypes = preview?.rows.some(
        (row) => row.status === "unknown_type",
    );

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{i18n("Import a list")}</DialogTitle>
                    <DialogDescription>
                        {i18n(
                            "One line per type: the type, a colon, then names separated by commas. Nicknames go in parentheses.",
                        )}
                    </DialogDescription>
                </DialogHeader>
                {preview ? (
                    <div className="space-y-3">
                        <div className="overflow-x-auto rounded-md border">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                                    <tr>
                                        <th className="px-3 py-2 font-medium">
                                            {i18n("Name")}
                                        </th>
                                        <th className="px-3 py-2 font-medium">
                                            {i18n("Kind")}
                                        </th>
                                        <th className="px-3 py-2 font-medium">
                                            {i18n("What happens")}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y">
                                    {preview.rows.map((row, index) => (
                                        <tr key={`${row.line}-${index}`}>
                                            <td className="px-3 py-1.5">
                                                {row.name}
                                                {row.nicknames.length > 0 && (
                                                    <span className="text-muted-foreground">
                                                        {" "}
                                                        (
                                                        {row.nicknames.join(
                                                            ", ",
                                                        )}
                                                        )
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                {row.typeKey === "person"
                                                    ? i18n("Person")
                                                    : row.typeKey
                                                      ? (typeLabels[
                                                            row.typeKey
                                                        ] ?? row.typeKey)
                                                      : row.typeText}
                                            </td>
                                            <td
                                                className={
                                                    row.status === "create" ||
                                                    row.status === "exists"
                                                        ? "px-3 py-1.5"
                                                        : "px-3 py-1.5 text-amber-700 dark:text-amber-400"
                                                }
                                            >
                                                {statusText(
                                                    row.status,
                                                    row.nicknames.length,
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {preview.problems.length > 0 && (
                            <p className="text-sm text-amber-700 dark:text-amber-400">
                                {i18n("Lines not understood: {lines}", {
                                    lines: preview.problems
                                        .map((problem) => problem.line)
                                        .join(", "),
                                })}
                            </p>
                        )}
                        {unknownTypes && (
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "An import never makes new types. Add them in the vocabulary first:",
                                )}{" "}
                                <Link
                                    href="/almanac/vocabulary"
                                    className="text-primary hover:underline"
                                >
                                    {i18n("Vocabulary")}
                                </Link>
                            </p>
                        )}
                    </div>
                ) : (
                    <textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        placeholder={EXAMPLE}
                        aria-label={i18n("List to import")}
                        className="min-h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                )}
                <DialogFooter>
                    {preview ? (
                        <>
                            <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => setPreview(null)}
                            >
                                {i18n("Back to the list")}
                            </Button>
                            <Button
                                disabled={busy || !actionable}
                                onClick={() => void apply()}
                            >
                                {i18n("Import")}
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => onOpenChange(false)}
                            >
                                {i18n("Cancel")}
                            </Button>
                            <Button
                                disabled={busy || !text.trim()}
                                onClick={() =>
                                    void send(true).then(
                                        (result) =>
                                            result && setPreview(result),
                                    )
                                }
                            >
                                {i18n("Preview")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
