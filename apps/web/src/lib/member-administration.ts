import type { OrgMembershipUpdate } from "@berry/shared";

type MembershipStatus = "pending" | "active" | "disabled" | "deprovisioned";
type MutableMembershipStatus = Exclude<MembershipStatus, "pending">;

const ACTIVE_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Blocked" },
  { value: "deprovisioned", label: "Offboarded" },
];

const PENDING_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "pending", label: "Pending Google sign-in" },
  { value: "disabled", label: "Revoke and block" },
  { value: "deprovisioned", label: "Revoke and offboard" },
];

export function memberAccessStatusOptions(status: MembershipStatus) {
  return status === "pending" ? PENDING_STATUS_OPTIONS : ACTIVE_STATUS_OPTIONS;
}

export function memberStatusUpdate(
  currentStatus: MembershipStatus,
  selectedStatus: string,
): Pick<OrgMembershipUpdate, "status"> {
  if (currentStatus === "pending" && selectedStatus === "pending") return {};
  if (selectedStatus === "active" || selectedStatus === "disabled" || selectedStatus === "deprovisioned") {
    return { status: selectedStatus as MutableMembershipStatus };
  }
  return {};
}
