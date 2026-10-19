/** The dot between items of an item header's metadata row. */
export function MetadataSeparator() {
    return (
        <span
            data-slot="metadata-separator"
            aria-hidden="true"
            className="opacity-40"
        >
            ·
        </span>
    );
}
