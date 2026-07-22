import type { ReactNode } from "react";
import { BookOpen, FileDown, Lightbulb, MessageSquare, Users } from "@berry/desktop-ui/lib/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { toast } from "sonner";
import { host } from "@/lib/berry";

const ISSUES_URL = "https://github.com/berry-chat/berry/issues";
const COMMUNITY_URL = "https://berry.me/community";
const DOCS_URL = "https://berry.me/docs";

function openExternal(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function exportLogs() {
  try {
    const { path } = await host.call<{ path: string }>("logs.export");
    toast.success(`Logs exported to ${path}`);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not export logs");
  }
}

async function createIssueBundle() {
  try {
    const result = await host.call<{
      path: string;
      issueBodyPath: string | null;
      configHash: string;
    }>("support.issueReport.create");
    toast.success("Issue bundle created", {
      description: result.issueBodyPath ? `${result.path} and ${result.issueBodyPath}` : result.path,
    });
    openExternal(ISSUES_URL);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Could not create issue bundle");
  }
}

export function HelpMenu({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => openExternal(ISSUES_URL)}>
          <MessageSquare />
          Report issue
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void createIssueBundle()}>
          <FileDown />
          Create issue bundle
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openExternal(ISSUES_URL)}>
          <Lightbulb />
          Request feature
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openExternal(COMMUNITY_URL)}>
          <Users />
          Community
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openExternal(DOCS_URL)}>
          <BookOpen />
          Product docs
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportLogs()}>
          <FileDown />
          Export logs
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
