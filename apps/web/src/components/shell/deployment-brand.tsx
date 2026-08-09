import * as React from "react";
import { BerryLogo } from "@berry/desktop-ui/components/berry-logo";

export type DeploymentBrand = {
  applicationName: string;
  logoUrl: string | null;
  accentColor: string | null;
};

export const DEFAULT_DEPLOYMENT_BRAND: DeploymentBrand = { applicationName: "Berry", logoUrl: null, accentColor: null };
export const DeploymentBrandContext = React.createContext<DeploymentBrand>(DEFAULT_DEPLOYMENT_BRAND);

export function useDeploymentBrand(): DeploymentBrand {
  return React.useContext(DeploymentBrandContext);
}

export function DeploymentBrandLogo({ className, alt = "" }: { className?: string; alt?: string }) {
  const brand = useDeploymentBrand();
  return brand.logoUrl
    ? <img className={`${className ?? ""} berry-deployment-logo`} src={brand.logoUrl} alt={alt} />
    : <BerryLogo className={className} alt={alt} />;
}
