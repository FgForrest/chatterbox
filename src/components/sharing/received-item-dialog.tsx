"use client";

import {
    AudioLines,
    Check,
    FileText,
    FolderInput,
    Info,
    ListChecks,
    Lock,
    Mail,
} from "lucide-react";
import { useExtracted, useFormatter } from "next-intl";
import { useId, useMemo, useState } from "react";
import {
    type CreatedFolder,
    NewFolderForm,
} from "@/components/pipeline/new-folder-form";
import { FolderSearchList } from "@/components/recordings/folder-search-list";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { useFolderLabel } from "@/hooks/use-folder-label";
import { useLibraryPreferences } from "@/hooks/use-library-preferences";
import { joinFolderPath, matchFolders } from "@/lib/folders/navigation";
import { cn } from "@/lib/utils";
import type { RecordingFolder } from "@/types/folder";

export interface SharedItemPreview {
    title: string;
    kind: "audio" | "mail";
    ownerName: string;
    invitedAt?: Date | string;
    visibleInFolders: { id: string; name: string }[];
}

/** One acceptance and filing body for recordings and email, with optional existing folder paths. */
export function ReceivedItemDialog({
    item,
    folders,
    action = "accept",
    initiallyAlso = false,
    initialFolderId,
    open,
    onOpenChange,
    onSave,
    onFolderCreated,
}: {
    item: SharedItemPreview;
    folders: RecordingFolder[];
    action?: "accept" | "file";
    initiallyAlso?: boolean;
    initialFolderId?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (folderId?: string) => Promise<void>;
    onFolderCreated?: (folder: CreatedFolder) => void;
}) {
    const i18n = useExtracted();
    const format = useFormatter();
    const label = useFolderLabel();
    const { rememberFolder } = useLibraryPreferences();
    const id = useId();
    const [also, setAlso] = useState(initiallyAlso || Boolean(initialFolderId));
    const [folderId, setFolderId] = useState(initialFolderId ?? "");
    const [created, setCreated] = useState<RecordingFolder[]>([]);
    const [creating, setCreating] = useState(false);
    const [query, setQuery] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const entries = useMemo(
        () =>
            matchFolders(
                [
                    ...folders,
                    ...created.filter(
                        (folder) =>
                            !folders.some((item) => item.id === folder.id),
                    ),
                ].filter(
                    (folder) =>
                        folder.scope === "personal" &&
                        !folder.receivedFolder &&
                        folder.kind !== "public",
                ),
                "",
                label,
            ),
        [folders, created, label],
    );
    const paths = item.visibleInFolders;
    const names = paths.map((folder) => folder.name).join(", ");
    const pathFolder =
        paths.length === 1
            ? folders.find((folder) => folder.id === paths[0].id)
            : undefined;
    const chooseFolder = !paths.length || also;
    const selectedFolder = entries.find(
        (entry) => entry.folder.id === folderId,
    )?.folder;
    let title: string;
    if (action === "file")
        title =
            item.kind === "mail" ? i18n("File email") : i18n("File recording");
    else
        title =
            item.kind === "mail"
                ? i18n("Accept email")
                : i18n("Accept recording");
    const save = async () => {
        if (saving || (chooseFolder && !folderId)) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(chooseFolder ? folderId : undefined);
            if (chooseFolder) rememberFolder(folderId);
            onOpenChange(false);
        } catch (error) {
            setError(
                error instanceof Error
                    ? error.message
                    : i18n("Could not update sharing"),
            );
        } finally {
            setSaving(false);
        }
    };
    const Icon = item.kind === "mail" ? Mail : AudioLines;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
                onKeyDown={(event) => {
                    if (["j", "k", "/"].includes(event.key))
                        event.stopPropagation();
                }}
            >
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className="sr-only">
                    {item.title}
                </DialogDescription>
                <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
                    <Icon className="size-9 shrink-0 rounded-lg bg-muted p-2" />
                    <div className="min-w-0">
                        <p className="font-medium [overflow-wrap:anywhere]">
                            {item.title}
                        </p>
                        <p className="text-sm text-person-share">
                            {i18n("Shared by {owner}", {
                                owner: item.ownerName,
                            })}
                            {item.invitedAt && (
                                <span className="text-muted-foreground">
                                    {" "}
                                    ·{" "}
                                    {format.dateTime(new Date(item.invitedAt))}
                                </span>
                            )}
                        </p>
                    </div>
                </div>
                {paths.length ? (
                    <>
                        <p className="flex gap-2 rounded-lg border border-person-share/30 bg-person-share/10 p-3 text-sm">
                            <FolderInput className="size-5 shrink-0 text-person-share" />
                            {pathFolder?.receivedFolder
                                ? i18n(
                                      "You already see it in {folder}, a folder {owner} shares with you.",
                                      {
                                          folder: names,
                                          owner: pathFolder.receivedFolder
                                              .ownerName,
                                      },
                                  )
                                : i18n("You already see it in {folder}.", {
                                      folder: names,
                                  })}
                        </p>
                        <fieldset className="space-y-2" disabled={saving}>
                            <legend className="mb-2 font-medium">
                                {i18n("Where do you want it?")}
                            </legend>
                            {[false, true].map((value) => (
                                <label
                                    key={String(value)}
                                    className={cn(
                                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm",
                                        also === value &&
                                            "border-primary bg-primary/10",
                                    )}
                                >
                                    <input
                                        type="radio"
                                        name={id}
                                        checked={also === value}
                                        onChange={() => setAlso(value)}
                                        className="mt-1 accent-primary"
                                    />
                                    <span>
                                        <span className="block font-medium">
                                            {value
                                                ? i18n(
                                                      "Also in another folder of mine…",
                                                  )
                                                : i18n("Only in {folder}", {
                                                      folder: names,
                                                  })}
                                        </span>
                                        <span className="text-muted-foreground">
                                            {value
                                                ? i18n(
                                                      "You will then see it in two places.",
                                                  )
                                                : i18n(
                                                      "It will not show up twice.",
                                                  )}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                    </>
                ) : (
                    <>
                        <ul className="space-y-2 text-sm">
                            <li className="flex items-center gap-2">
                                <FileText className="size-4 shrink-0 text-muted-foreground" />
                                {item.kind === "mail"
                                    ? i18n(
                                          "You can read the email and summary.",
                                      )
                                    : i18n(
                                          "You can read the transcript and summary.",
                                      )}
                            </li>
                            <li className="flex items-center gap-2">
                                <ListChecks className="size-4 shrink-0 text-muted-foreground" />
                                {i18n(
                                    "You can complete tasks assigned to you.",
                                )}
                            </li>
                            <li className="flex items-center gap-2">
                                <Lock className="size-4 shrink-0 text-muted-foreground" />
                                {i18n(
                                    "It stays private. The Organization does not see it.",
                                )}
                            </li>
                        </ul>
                        <div className="space-y-1 border-t pt-4">
                            <h3 className="font-medium">
                                {i18n("Where will you keep it?")}
                            </h3>
                            <p className="text-sm text-muted-foreground">
                                {i18n(
                                    "Pick one of your folders. Nothing changes for {owner}.",
                                    { owner: item.ownerName },
                                )}
                            </p>
                        </div>
                    </>
                )}
                {chooseFolder &&
                    (creating ? (
                        <NewFolderForm
                            parents={entries.map((entry) => ({
                                id: entry.folder.id,
                                path: joinFolderPath(
                                    entry.path,
                                    label(entry.folder),
                                ),
                            }))}
                            idPrefix={id}
                            onCancel={() => setCreating(false)}
                            onCreated={(folder) => {
                                onFolderCreated?.(folder);
                                setCreated((current) => [...current, folder]);
                                setFolderId(folder.id);
                                setCreating(false);
                            }}
                        />
                    ) : (
                        <div className="space-y-2">
                            <FolderSearchList
                                entries={entries.filter(
                                    ({ folder }) => folder.kind !== "private",
                                )}
                                query={query}
                                onQueryChange={setQuery}
                                onSelect={setFolderId}
                                disabled={saving}
                                onCreate={
                                    entries.length
                                        ? () => setCreating(true)
                                        : undefined
                                }
                            />
                            {selectedFolder && (
                                <p className="flex items-center gap-2 text-sm text-primary">
                                    <Check className="size-4" />
                                    {label(selectedFolder)}
                                </p>
                            )}
                        </div>
                    ))}
                {paths.length > 0 && action === "accept" && (
                    <p className="flex gap-2 text-sm text-muted-foreground">
                        <Info className="size-4 shrink-0" />
                        {i18n(
                            "Accepting keeps it for you even if {owner} takes it out of {folder}.",
                            { owner: item.ownerName, folder: names },
                        )}
                    </p>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <div className="flex justify-end gap-2">
                    <Button
                        variant="ghost"
                        disabled={saving}
                        onClick={() => onOpenChange(false)}
                    >
                        {i18n("Back")}
                    </Button>
                    <Button
                        disabled={
                            saving || creating || (chooseFolder && !folderId)
                        }
                        onClick={() => void save()}
                    >
                        {action === "file" ? i18n("Save") : i18n("Accept")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
