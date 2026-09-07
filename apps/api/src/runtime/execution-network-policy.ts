import { ForbiddenException } from "@nestjs/common";
import { networkDomainAllowed, parseNetworkDomainAllowlist, type ExecutionNetworkPolicy, type NetworkPolicy } from "@berry/shared";

/** An explicitly saved organization policy replaces deployment defaults. */
export function organizationNetworkPolicy(policy: ExecutionNetworkPolicy | null, fallback: NetworkPolicy | undefined): NetworkPolicy | undefined {
  if (!policy) return fallback;
  if (policy.outboundNetwork === "blocked") return { egress: "off", allowedDomains: [] };
  const blocked = domains(policy.blockedDomains);
  if (policy.outboundNetwork === "unrestricted") {
    // E2B denies IPs/CIDRs, not domains. Never silently discard a domain deny.
    if (blocked.length) throw new ForbiddenException({ code: "network_policy_not_enforceable", message: "Blocked domains require allowlist mode with explicit allowed hosts. Unrestricted access with domain exclusions is not supported by the sandbox." });
    return { egress: "unrestricted", allowedDomains: [] };
  }
  const allowed = domains(policy.allowedDomains).filter((host) =>
    !blocked.some((deny) => host === deny || networkDomainAllowed(host, [deny])));
  for (const host of allowed) {
    if (host.startsWith("*.") && blocked.some((deny) => networkDomainAllowed(deny.replace(/^\*\./, "probe."), [host]))) {
      throw new ForbiddenException({ code: "network_policy_not_enforceable", message: `The allow rule ${host} overlaps a blocked domain. Use explicit allowed hosts so the sandbox can enforce the exclusion.` });
    }
  }
  // Empty legacy allowlists permit all domains; an explicitly empty saved
  // allowlist must instead disable egress.
  return { egress: allowed.length ? "on" : "off", allowedDomains: allowed };
}

function domains(values: string[]): string[] {
  try { return parseNetworkDomainAllowlist(values); }
  catch { throw new ForbiddenException({ code: "invalid_network_policy", message: "The saved network policy contains an invalid domain. An organization admin must correct it in Execution & network before retrying." }); }
}
