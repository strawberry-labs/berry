import type { BerryApiClient } from "@berry/api-client";
import { ManagementDialog } from "./management-primitives";
import { MobileDevicesSection } from "./mobile-devices-section";

/** An administrator's view of one member's paired phones. */
export function MemberDevicesDialog({ client, tenantId, member, canRevoke, onClose }: {
  client: BerryApiClient | null;
  tenantId: string;
  member: { userId: string; name: string };
  canRevoke: boolean;
  onClose: () => void;
}) {
  return (
    <ManagementDialog open onOpenChange={(open) => { if (!open) onClose(); }} title={`${member.name || "Member"}’s phones`} description="Phones signed in to this member’s account with the Berry app." size="lg">
      <MobileDevicesSection
        resourceKey={`member-mobile-devices:${tenantId}:${member.userId}`}
        title="Signed-in phones"
        description={canRevoke ? "Signing a phone out takes effect the next time it connects. The member can sign in again with a new code." : "You can view these phones but not sign them out."}
        emptyText="This member hasn’t signed in on a phone."
        load={async () => client ? client.listMemberMobileDevices(tenantId, member.userId) : []}
        revoke={async (deviceId) => { if (client && canRevoke) await client.revokeMemberMobileDevice(tenantId, member.userId, deviceId); }}
        readOnly={!canRevoke}
      />
    </ManagementDialog>
  );
}
