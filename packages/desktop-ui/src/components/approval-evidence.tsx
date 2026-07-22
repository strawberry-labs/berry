import { Badge } from "@berry/desktop-ui/components/ui/badge";

export interface ApprovalEvidenceProps {
  detail?: string | undefined;
  rawDetail?: string | undefined;
  diff?: string | undefined;
  destructive?: boolean | undefined;
  openWorld?: boolean | undefined;
  fallback?: string | undefined;
}

export function ApprovalEvidence({ detail, rawDetail, diff, destructive, openWorld, fallback }: ApprovalEvidenceProps) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {destructive || openWorld ? (
        <div className="flex flex-wrap gap-1.5">
          {destructive ? <Badge variant="destructive">Destructive</Badge> : null}
          {openWorld ? <Badge variant="outline">Open world</Badge> : null}
        </div>
      ) : null}
      {detail ? (
        <pre className="overflow-x-auto rounded-md bg-background/45 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground shadow-[var(--berry-ring-subtle)]">
          {detail}
        </pre>
      ) : fallback ? <p className="text-sm text-muted-foreground text-pretty">{fallback}</p> : null}
      {rawDetail ? (
        <details className="group text-xs text-muted-foreground">
          <summary className="min-h-10 cursor-pointer content-center select-none hover:text-foreground">Raw command</summary>
          <pre className="overflow-x-auto rounded-md bg-background/45 p-3 font-mono leading-5 whitespace-pre-wrap shadow-[var(--berry-ring-subtle)]">{rawDetail}</pre>
        </details>
      ) : null}
      {diff ? (
        <div className="overflow-hidden rounded-md bg-background/55 shadow-[var(--berry-ring-subtle)]">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground">Proposed changes</div>
          <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs leading-5">
            {diff.split("\n").map((line, index) => (
              <span
                // Diff lines are positional and may repeat.
                key={`${index}-${line}`}
                className={`block min-w-max whitespace-pre ${line.startsWith("+") && !line.startsWith("+++") ? "text-success" : line.startsWith("-") && !line.startsWith("---") ? "text-destructive" : "text-muted-foreground"}`}
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
