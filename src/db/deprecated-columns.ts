/**
 * A column kept in the schema after the code stopped using it, waiting for
 * its drop. Its schema property is named `deprecated<Name>`, and nothing
 * outside `src/db/` may use it.
 */
export interface DeprecatedColumn {
    /** SQL table name. */
    table: string;
    /** SQL column name. */
    column: string;
    /** Why it is still there, and where its data lives now. */
    why: string;
    /**
     * ISO date after which `src/tests/db/deprecated-columns.test.ts` fails
     * while the column is still in the schema. Moved only by editing this
     * entry in a reviewed change.
     */
    dropAfter: string;
    /** GitHub issue tracking the drop, once opened. */
    issue: number | null;
}

/**
 * Every deprecated column. Dropping one: remove it from `schema.ts`, run
 * `pnpm db:generate` (a pure removal, no prompt), delete its entry here and
 * close its issue.
 */
export const DEPRECATED_COLUMNS: readonly DeprecatedColumn[] = [];
