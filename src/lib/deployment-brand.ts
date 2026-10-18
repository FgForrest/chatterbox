import { productName, UPSTREAM_PRODUCT_NAME } from "@/lib/brand";
import { env } from "@/lib/env";

/** Returns the product name for this deployment and locale. */
export function deploymentProductName(locale: string): string {
    return env.IS_HOSTED ? UPSTREAM_PRODUCT_NAME : productName(locale);
}
