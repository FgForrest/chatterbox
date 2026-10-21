import { SETUP_FLOW_KEY } from "./constants.js";

export const SETUP_FLOW_TTL_MS = 15 * 60 * 1000;

/** Match only the tab and origin explicitly authorized by an active setup. */
export async function activeSetupFlow(origin, tabId, browser = chrome) {
    const flow = (await browser.storage.session.get(SETUP_FLOW_KEY))[
        SETUP_FLOW_KEY
    ];
    const age = Date.now() - flow?.createdAt;
    if (
        !origin ||
        !Number.isInteger(tabId) ||
        flow?.origin !== origin ||
        flow.tabId !== tabId ||
        flow.connected !== true ||
        flow.completed ||
        !(age >= 0 && age < SETUP_FLOW_TTL_MS) ||
        !(await browser.permissions.contains({ origins: [`${origin}/*`] }))
    )
        return null;
    const surface = await browser.tabs.get(flow.surfaceTabId).catch(() => null);
    const expected = browser.runtime.getURL("options/options.html");
    if (surface?.url?.split("?")[0] !== expected) return null;
    return flow;
}

/** Resume a typed-address setup when sign-in returns its tab to the dashboard. */
export async function resumeTypedSetupAfterLogin(tab, browser = chrome) {
    let url;
    try {
        url = new URL(tab.url);
    } catch {
        return false;
    }
    const flow = await activeSetupFlow(url.origin, tab.id, browser);
    if (!flow?.typed || flow.resumedAfterLogin) return false;
    if (["/login", "/register"].includes(url.pathname)) {
        if (!flow.loginSeen)
            await browser.storage.session.set({
                [SETUP_FLOW_KEY]: { ...flow, loginSeen: true },
            });
        return false;
    }
    if (url.pathname !== "/dashboard" || !flow.loginSeen) return false;
    await browser.storage.session.set({
        [SETUP_FLOW_KEY]: { ...flow, resumedAfterLogin: true },
    });
    await browser.tabs.update(tab.id, {
        url: `${flow.origin}/settings?section=recorder`,
    });
    return true;
}
