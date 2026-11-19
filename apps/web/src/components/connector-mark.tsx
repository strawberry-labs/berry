import { PlugZap } from "lucide-react";

const PRODUCT_MARKS = new Map([
  ["google-workspace", "/connectors/google/drive.svg"],
  ["gmail", "/connectors/google/gmail.svg"],
  ["google-calendar", "/connectors/google/calendar.svg"],
]);

export function ConnectorMark({ connectorKey, className }: { connectorKey: string; className?: string }) {
  const src = PRODUCT_MARKS.get(connectorKey);
  return src
    ? <img src={src} alt="" aria-hidden className={className} />
    : <PlugZap aria-hidden className={className} />;
}

export function GoogleWorkspaceWordmark() {
  return <>
    <img className="h-5 w-auto dark:hidden" src="/connectors/google/workspace-wordmark.png" alt="Google Workspace" />
    <span className="hidden dark:inline">Google Workspace</span>
  </>;
}
