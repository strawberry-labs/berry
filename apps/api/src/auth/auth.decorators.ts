import { SetMetadata } from "@nestjs/common";

export const BERRY_AUTH_PUBLIC = "berry.auth.public";

export const PublicAuth = () => SetMetadata(BERRY_AUTH_PUBLIC, true);
