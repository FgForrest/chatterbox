import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

type EditorActionsProps = {
    hint?: ReactNode;
    cancelLabel: string;
    saveLabel: string;
    onCancel: () => void;
    saving?: boolean;
    saveDisabled?: boolean;
} & (
    | { type: "submit"; onSave?: never }
    | { type?: "button"; onSave: () => void }
);

/** The shared hint and translated cancel/save actions beneath an inline editor. */
export function EditorActions({
    hint,
    cancelLabel,
    saveLabel,
    onCancel,
    type = "button",
    onSave,
    saving = false,
    saveDisabled = false,
}: EditorActionsProps) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            {hint && (
                <p className="max-w-md text-xs text-muted-foreground">{hint}</p>
            )}
            <div className="ml-auto flex gap-2">
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={onCancel}
                >
                    {cancelLabel}
                </Button>
                <Button
                    type={type}
                    size="sm"
                    disabled={saving || saveDisabled}
                    onClick={onSave}
                >
                    {saveLabel}
                </Button>
            </div>
        </div>
    );
}
