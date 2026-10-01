import type { ReactNode } from "react";
import { AlmanacTabs } from "@/components/almanac/almanac-tabs";
import { AppHeader } from "@/components/app-header";
import { AppNav } from "@/components/app-nav";
import { isLearnDeploymentAvailable } from "@/lib/knowledge/availability";

/**
 * The Almanac: the people and things Riffado knows, the vocabulary it
 * knows them by, and Learn's reviews waiting for the viewer. One header
 * and one row of tabs for all of its pages.
 */
export default function AlmanacLayout({ children }: { children: ReactNode }) {
    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <AppHeader>
                <AppNav className="min-w-0" />
            </AppHeader>
            <AlmanacTabs learn={isLearnDeploymentAvailable()} />
            {children}
        </div>
    );
}
