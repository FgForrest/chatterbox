import { meetCode } from "./meet-code.js";

const hostLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const roomSlug = /^[a-z0-9][a-z0-9_-]*$/;
const wherebyRoutes = new Set([
    "about", "account", "admin", "business", "dashboard", "developer", "developers",
    "embed", "help", "home", "join", "login", "logout", "meet", "meeting", "pricing",
    "privacy", "rooms", "settings", "signin", "signup", "start", "terms", "user",
]);
const wherebyServiceHosts = new Set(["api", "docs", "status", "support", "www"]);
const webexServiceHosts = new Set(["developer", "help", "signin", "status", "www"]);
const jitsiRoutes = new Set([
    "about", "auth", "config", "help", "index", "interface_config", "join",
    "login", "logout", "manifest", "privacy", "settings", "static", "terms",
]);

function hostIs(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

function namespacedSlug(host, domain) {
    const site = host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : "";
    return hostLabel.test(site) ? site : null;
}

function teamsId(path) {
    const numeric = /^\/meet\/([0-9]+)\/?$/.exec(path);
    if (numeric) return numeric[1];
    const token = /^\/(?:l\/)?meetup-join\/([^/]+)(?:\/0)?\/?$/.exec(path)?.[1];
    if (!token) return null;
    try {
        const id = decodeURIComponent(token);
        return !/\s/.test(id) && /^19:meeting_[A-Za-z0-9_-]+@thread\.v2$/.test(id) ? id : null;
    } catch {
        return null;
    }
}

function slugRoom(path, reserved) {
    const slug = /^\/([^/]+)\/?$/.exec(path)?.[1].toLowerCase();
    return slug && roomSlug.test(slug) && !reserved.has(slug) ? slug : null;
}

function roomId(url) {
    const { hostname, pathname, hash } = url;
    const code = meetCode(url);
    if (code) return ["meet", code];

    if (hostIs(hostname, "zoom.us")) {
        const id = /^\/wc\/([0-9]+)(?:\/[^/]+)*\/?$/.exec(pathname)?.[1] ??
            /^\/j\/([0-9]+)\/?$/.exec(pathname)?.[1];
        if (id) return ["zoom", id];
    }

    if (["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"].some(domain => hostIs(hostname, domain))) {
        const pathId = teamsId(pathname);
        const hashId = teamsId(hash.slice(1).split("?")[0]);
        if (pathId && hashId && pathId !== hashId) return null;
        if (pathId || hashId) return ["teams", pathId ?? hashId];
    }

    const site = namespacedSlug(hostname, "webex.com");
    if (site && !webexServiceHosts.has(site)) {
        const name = /^\/meet\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/.exec(pathname)?.[1];
        if (name) return ["webex", `${site}/${name.toLowerCase()}`];
    }

    if (hostname === "app.slack.com") {
        const huddle = /^\/huddle\/(T[A-Z0-9]+\/[CGD][A-Z0-9]+)\/?$/.exec(pathname);
        if (huddle) return ["slack", huddle[1]];
    }

    const wherebySite = namespacedSlug(hostname, "whereby.com");
    if (hostname === "whereby.com" || (wherebySite && !wherebyServiceHosts.has(wherebySite))) {
        const slug = slugRoom(pathname, wherebyRoutes);
        if (slug) return ["whereby", `${hostname}/${slug}`];
    }

    if (hostname === "meet.jit.si") {
        const slug = slugRoom(pathname, jitsiRoutes);
        if (slug) return ["jitsi", slug];
    }
    return null;
}

/** Return the canonical identity of a supported meeting URL. */
export function meetingRoom(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
    const identity = roomId(url);
    return identity && identity[1].length <= 256 ? identity.join(":") : null;
}
