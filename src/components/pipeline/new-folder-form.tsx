"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { getApiErrorMessage } from "@/lib/api-errors";
import type { RecordingFolder } from "@/types/folder";

export interface NewFolderParent {
    id: string;
    path: string;
}

export type CreatedFolder = RecordingFolder;

export function NewFolderForm({
    parents,
    idPrefix,
    onCancel,
    onCreated,
}: {
    parents: readonly NewFolderParent[];
    idPrefix: string;
    onCancel: () => void;
    onCreated: (folder: CreatedFolder) => void;
}) {
    const i18n = useExtracted();
    const [name, setName] = useState("");
    const [parentId, setParentId] = useState(parents[0]?.id ?? "");
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        setParentId((current) =>
            parents.some((parent) => parent.id === current)
                ? current
                : (parents[0]?.id ?? ""),
        );
    }, [parents]);

    const createFolder = async () => {
        const trimmedName = name.trim();
        if (!trimmedName || !parentId) return;
        setCreating(true);
        try {
            const response = await fetch("/api/folders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ parentId, name: trimmedName }),
            });
            if (!response.ok) {
                toast.error(
                    await getApiErrorMessage(
                        response,
                        i18n("The folder could not be created."),
                    ),
                );
                return;
            }
            const { folder } = (await response.json()) as {
                folder: CreatedFolder;
            };
            onCreated(folder);
            setName("");
            toast.success(i18n("Folder created."));
        } catch {
            toast.error(i18n("The folder could not be created."));
        } finally {
            setCreating(false);
        }
    };

    return (
        <div className="space-y-3 border-t pt-3">
            <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-new-folder-name`}>
                    {i18n("Folder name")}
                </Label>
                <Input
                    id={`${idPrefix}-new-folder-name`}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>
            <div className="space-y-1.5">
                <Label>{i18n("Parent folder")}</Label>
                <Select value={parentId} onValueChange={setParentId}>
                    <SelectTrigger
                        className="w-full"
                        aria-label={i18n("Parent folder")}
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {parents.map((parent) => (
                            <SelectItem key={parent.id} value={parent.id}>
                                {parent.path}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="flex justify-end gap-2">
                <Button
                    type="button"
                    variant="ghost"
                    onClick={onCancel}
                    disabled={creating}
                >
                    {i18n("Cancel")}
                </Button>
                <Button
                    type="button"
                    onClick={() => void createFolder()}
                    disabled={creating || !name.trim() || !parentId}
                >
                    {creating ? i18n("Creating…") : i18n("Create folder")}
                </Button>
            </div>
        </div>
    );
}
