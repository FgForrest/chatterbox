import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { AppUploadButton } from "@/components/app-upload-button";
import { HelpButton } from "@/components/help/help-button";

/** The viewer's tasks, under the app's header. */
export default function TasksLayout({ children }: { children: ReactNode }) {
    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader>
                <AppNav className="min-w-0" />
                <div className="ml-auto flex items-center gap-2">
                    <AppUploadButton />
                    <HelpButton />
                </div>
            </AppHeader>
            {children}
        </div>
    );
}
