"use client";

import { Plus } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";

/** The "Add task" action shown directly below a list of tasks. */
export function AddTaskButton({ onClick }: { onClick: () => void }) {
    const i18n = useExtracted();
    return (
        <Button size="sm" variant="ghost" onClick={onClick}>
            <Plus className="mr-1 size-3.5" />
            {i18n("Add task")}
        </Button>
    );
}
