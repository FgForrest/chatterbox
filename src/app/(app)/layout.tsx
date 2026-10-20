import { AppChromeProvider } from "@/components/app-chrome-provider";
import { Footer } from "@/components/footer";
import { HelpProvider } from "@/components/help/help-provider";
import { RebrandBanner } from "@/components/rebrand-banner";
import { Toaster } from "@/components/ui/sonner";
import { env } from "@/lib/env";
import { appChromeConfig } from "@/lib/settings/app-chrome";

export default async function AppLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const config = await appChromeConfig();
    return (
        <HelpProvider>
            <AppChromeProvider {...config}>
                <div className="flex flex-col min-h-[100vh]">
                    {/* In-app rebrand banner. Hosted-only: existing OpenPlaud
                    users land here directly (auth redirect from `/`) and
                    would otherwise miss the announcement entirely. The
                    component itself self-expires; the layout gate keeps
                    self-host operators (who already know via GitHub) from
                    seeing chrome that doesn't apply to them. */}
                    {env.IS_HOSTED ? <RebrandBanner /> : null}
                    <main className="flex-1 flex flex-col">{children}</main>
                    <Footer />
                </div>
                <Toaster />
            </AppChromeProvider>
        </HelpProvider>
    );
}
