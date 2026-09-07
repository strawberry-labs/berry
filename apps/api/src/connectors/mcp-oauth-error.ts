import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";

export function mcpOAuthStartError(cause: unknown, endpoint: string) {
  const message = cause instanceof Error ? cause.message : "";
  const mismatch = /^Protected resource (\S+) does not match expected /.exec(message);
  if (mismatch) {
    let suggestion = "Check the server's MCP endpoint URL and add it again using the correct address.";
    try {
      const resource = new URL(mismatch[1]!);
      if (resource.origin === new URL(endpoint).origin && !resource.username && !resource.password && !resource.search && !resource.hash) {
        suggestion = `Add this server using ${resource.toString()}, then reconnect.`;
      }
    } catch { /* Do not expose unvalidated upstream text. */ }
    return new BadRequestException({ code: "mcp_endpoint_mismatch", message: `The server identifies a different MCP endpoint than the saved URL. ${suggestion}` }, { cause });
  }
  return new ServiceUnavailableException({ code: "mcp_oauth_unavailable", message: "Could not start the server sign-in. Check the MCP endpoint URL and try again. If it continues, ask the server administrator to check its OAuth configuration." }, { cause });
}
