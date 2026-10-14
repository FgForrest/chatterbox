import {
    CAPABILITIES,
    type Capability,
    type Grant,
    IMPLICATIONS,
    type Implication,
    isGrant,
    type McpPermission,
} from "@/lib/authz/catalog";
import type { ActorContext } from "@/lib/authz/model";

/** Why a list of implications cannot be used. */
export class CatalogError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CatalogError";
    }
}

/**
 * Check implications against the catalog: both ends known, no self
 * implication, no duplicate, no cycle. Throws {@link CatalogError}.
 */
export function validateImplications(
    implications: readonly Implication[],
    isKnown: (value: unknown) => boolean = isGrant,
): void {
    const seen = new Set<string>();
    const edges = new Map<string, string[]>();
    for (const { from, to } of implications) {
        if (!isKnown(from)) throw new CatalogError(`unknown grant ${from}`);
        if (!isKnown(to)) throw new CatalogError(`unknown grant ${to}`);
        if (from === to) throw new CatalogError(`${from} implies itself`);
        const key = `${from}\u0000${to}`;
        if (seen.has(key)) {
            throw new CatalogError(`duplicate implication ${from} -> ${to}`);
        }
        seen.add(key);
        edges.set(from, [...(edges.get(from) ?? []), to]);
    }

    const done = new Set<string>();
    const path = new Set<string>();
    const visit = (node: string): void => {
        if (done.has(node)) return;
        if (path.has(node)) {
            throw new CatalogError(`implication cycle through ${node}`);
        }
        path.add(node);
        for (const next of edges.get(node) ?? []) visit(next);
        path.delete(node);
        done.add(node);
    };
    for (const node of edges.keys()) visit(node);
}

validateImplications(IMPLICATIONS);

/**
 * `granted` with everything it implies, transitively. Unknown values are
 * dropped, never passed through.
 */
export function expandGrants<T extends Grant>(
    granted: Iterable<unknown>,
    implications: readonly Implication[] = IMPLICATIONS,
): Set<T> {
    const result = new Set<T>();
    const queue: Grant[] = [];
    for (const value of granted) {
        if (isGrant(value) && !result.has(value as T)) {
            result.add(value as T);
            queue.push(value);
        }
    }
    while (queue.length > 0) {
        const current = queue.shift() as Grant;
        for (const { from, to } of implications) {
            if (from === current && !result.has(to as T)) {
                result.add(to as T);
                queue.push(to);
            }
        }
    }
    return result;
}

/** Whether the actor holds `capability` (and `use`, which every capability needs). */
export function hasCapability(
    actor: Pick<ActorContext, "capabilities">,
    capability: Capability,
): boolean {
    return actor.capabilities.has("use") && actor.capabilities.has(capability);
}

/** Whether the actor may use the application at all. */
export function mayUse(actor: Pick<ActorContext, "capabilities">): boolean {
    return actor.capabilities.has("use");
}

/** Whether the actor may curate the Organization's content: `use` and `org.curate`. */
export function mayCurate(actor: Pick<ActorContext, "capabilities">): boolean {
    return hasCapability(actor, "org.curate");
}

/** Whether the actor may manage access: `use` and `access.manage`. */
export function mayManageAccess(
    actor: Pick<ActorContext, "capabilities">,
): boolean {
    return hasCapability(actor, "access.manage");
}

/** Whether an MCP caller holds `permission`. */
export function hasMcpPermission(
    actor: Pick<ActorContext, "clientPermissions">,
    permission: McpPermission,
): boolean {
    return actor.clientPermissions.has(permission);
}

/** Capabilities in catalog order, for storage and display. */
export function orderedCapabilities(
    capabilities: Iterable<Capability>,
): Capability[] {
    const held = new Set(capabilities);
    return CAPABILITIES.filter((capability) => held.has(capability));
}
