"use client";

import { useLocale } from "next-intl";
import { createContext, type ReactNode, useContext } from "react";
import { productName, UPSTREAM_PRODUCT_NAME } from "@/lib/brand";

const HostedDeploymentContext = createContext(false);

interface ProductNameProviderProps {
    children: ReactNode;
    isHosted: boolean;
}

/** Makes the server-resolved deployment mode available to client components. */
export function ProductNameProvider({
    children,
    isHosted,
}: ProductNameProviderProps) {
    return (
        <HostedDeploymentContext value={isHosted}>
            {children}
        </HostedDeploymentContext>
    );
}

/** Reports whether this deployment is the hosted service. */
export function useHostedDeployment(): boolean {
    return useContext(HostedDeploymentContext);
}

/** Returns the deployment-aware product name for the active locale. */
export function useProductName(): string {
    const isHosted = useHostedDeployment();
    const locale = useLocale();
    return isHosted ? UPSTREAM_PRODUCT_NAME : productName(locale);
}
