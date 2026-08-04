import { SetMetadata } from "@nestjs/common";

export const BERRY_AUTH_PUBLIC = "berry.auth.public";
export const BERRY_AUTH_INACTIVE_MEMBERSHIP_ALLOWED = "berry.auth.inactive-membership-allowed";

export const PublicAuth = () => SetMetadata(BERRY_AUTH_PUBLIC, true);
export const AllowInactiveMembershipAuth = () =>
  SetMetadata(BERRY_AUTH_INACTIVE_MEMBERSHIP_ALLOWED, true);
