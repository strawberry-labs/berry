import type { AuthenticatedRequest } from "../auth/auth.guard.ts";
export const PLATFORM_AUTHORIZER = Symbol("PLATFORM_AUTHORIZER");
export interface PlatformAuthorizer { authorize(request:AuthenticatedRequest):Promise<boolean>; }
export class ExplicitPlatformAuthorizer implements PlatformAuthorizer {
  private readonly users:Set<string>; private readonly emails:Set<string>;
  constructor(input:{userIds?:string[];emails?:string[]}){this.users=new Set(input.userIds??[]);this.emails=new Set((input.emails??[]).map((value)=>value.toLowerCase()));}
  async authorize(request:AuthenticatedRequest){const user=request.auth?.user;return Boolean(user&&(this.users.has(user.id)||this.emails.has(user.email.toLowerCase())));}
}
export class DenyPlatformAuthorizer implements PlatformAuthorizer { async authorize(){return false;} }
