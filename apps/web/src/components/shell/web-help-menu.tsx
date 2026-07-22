import { CircleHelp, FileDown, FileText, MessageSquare, NotebookPen } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@berry/desktop-ui/components/ui/dropdown-menu";

export function WebHelpMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Help" className="berry-titlebar-control"><CircleHelp /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Help</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => openExternal("https://berrydesk.com")}><FileText /> Documentation</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openExternal("mailto:support@berrydesk.com?subject=Berry%20issue%20report")}><MessageSquare /> Report an issue</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openExternal("mailto:support@berrydesk.com?subject=Berry%20feature%20request")}><NotebookPen /> Request a feature</DropdownMenuItem>
        <DropdownMenuItem onClick={() => openExternal("mailto:community@berrydesk.com?subject=Berry%20community")}><MessageSquare /> Community</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={downloadDiagnostics}><FileDown /> Download diagnostics</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function downloadDiagnostics() {
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    surface: "web",
    path: window.location.pathname,
    online: navigator.onLine,
    language: navigator.language,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `berry-diagnostics-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
