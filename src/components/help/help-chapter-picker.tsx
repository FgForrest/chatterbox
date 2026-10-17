"use client";

import { useRouter } from "next/navigation";
import { useExtracted } from "next-intl";
import { NativeSelect } from "@/components/ui/native-select";

/** Moves the help frame to another chapter of the user guide. */
export function HelpChapterPicker({
    chapters,
    current,
}: {
    chapters: { name: string; url: string }[];
    current: string;
}) {
    const i18n = useExtracted();
    const router = useRouter();
    return (
        <div className="sticky top-0 z-10 -mx-5 border-b bg-fd-background/95 px-5 py-2 backdrop-blur">
            <label
                htmlFor="help-chapter"
                className="flex items-center gap-2 text-sm text-fd-muted-foreground"
            >
                {i18n("Chapter")}
                <NativeSelect
                    id="help-chapter"
                    value={current}
                    onChange={(event) => router.push(event.target.value)}
                    className="h-8 min-w-0 flex-1"
                >
                    {chapters.map((chapter) => (
                        <option key={chapter.url} value={chapter.url}>
                            {chapter.name}
                        </option>
                    ))}
                </NativeSelect>
            </label>
        </div>
    );
}
