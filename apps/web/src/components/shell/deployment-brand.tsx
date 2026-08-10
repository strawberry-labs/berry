import * as React from "react";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";

export type DeploymentBrand = {
  applicationName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  accentColor: string | null;
};

export const DEFAULT_DEPLOYMENT_BRAND: DeploymentBrand = { applicationName: "Berry", logoUrl: null, faviconUrl: null, accentColor: null };
export const DeploymentBrandContext = React.createContext<DeploymentBrand>(DEFAULT_DEPLOYMENT_BRAND);

export function resolveDeploymentBrandAssetUrl(baseUrl: string, value: string | null | undefined): string | null {
  if (!value) return null;
  if (!baseUrl) return value;
  try {
    return new URL(value, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    return value;
  }
}

export function useDeploymentBrand(): DeploymentBrand {
  return React.useContext(DeploymentBrandContext);
}

export function DeploymentBrandLogo({ className, alt = "" }: { className?: string; alt?: string }) {
  const brand = useDeploymentBrand();
  return brand.logoUrl
    ? <img className={`${className ?? ""} berry-deployment-logo`} src={brand.logoUrl} alt={alt} />
    : <BerryLogo className={className} alt={alt} />;
}
