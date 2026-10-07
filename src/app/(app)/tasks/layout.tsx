import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { HelpButton } from "@/components/help/help-button";

/** The viewer's tasks, under the app's header. */
export default function TasksLayout({ children }: { children: ReactNode }) {
    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader>
                <AppNav className="min-w-0" />
                <HelpButton className="ml-auto" />
            </AppHeader>
            {children}
        </div>
    );
}
