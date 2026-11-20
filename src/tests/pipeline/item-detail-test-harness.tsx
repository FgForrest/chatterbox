import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
    ItemDetailProvider,
    useItemDetail,
} from "@/components/items/item-detail-store";
import { ItemWorkflow } from "@/components/pipeline/item-workflow";

type ProviderOptions = Omit<
    ComponentProps<typeof ItemDetailProvider>,
    "children"
>;

export function renderItemDetail(initial: ProviderOptions) {
    let current: ReturnType<typeof useItemDetail> = null;
    function Observe() {
        current = useItemDetail();
        return null;
    }
    const renderProvider = (options: ProviderOptions) => (
        <ItemDetailProvider {...options}>
            <Observe />
        </ItemDetailProvider>
    );
    const view = render(renderProvider(initial));
    return {
        result: {
            get current() {
                if (!current) throw new Error("Missing test item detail");
                return current;
            },
        },
        rerender: (next: ProviderOptions) =>
            view.rerender(renderProvider(next)),
        unmount: view.unmount,
    };
}

export function ItemWorkflowWithDetail({
    initialData,
    ...props
}: ComponentProps<typeof ItemWorkflow> & Pick<ProviderOptions, "initialData">) {
    return (
        <ItemDetailProvider
            key={props.itemId}
            itemId={props.itemId}
            kind={props.kind}
            view={props.view}
            isOwn={props.isOwn ?? true}
            enabled={props.isOwn !== false || props.view === "org"}
            initialData={initialData}
        >
            <ItemWorkflow {...props} />
        </ItemDetailProvider>
    );
}
