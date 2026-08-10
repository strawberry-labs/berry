import { describe,expect,it,vi } from "vitest";import{InMemoryManagementRepository,ManagementService,PostgresManagementRepository}from"./management.service.ts";
const tenant="00000000-0000-7000-8000-000000000001",user="00000000-0000-7000-8000-000000000201";
describe("management service",()=>{it("shows a service-account token once and keeps list records redacted",async()=>{const s=new ManagementService(new InMemoryManagementRepository());const created=await s.createServiceAccount(tenant,user,{name:"CI deployer",permissions:["org:read"],resourceRestrictions:[]});expect(created.token).toMatch(/^berry_sa_/);expect(created.account.tokenLast4).toBe(created.token.slice(-4));const listed=await s.listServiceAccounts(tenant);expect(listed).toHaveLength(1);expect(JSON.stringify(listed)).not.toContain(created.token);expect(JSON.stringify(listed)).not.toContain("tokenHash");});it("stores saved views, schedules, destinations, rules, and policy state",async()=>{const s=new ManagementService(new InMemoryManagementRepository());const view=await s.createView(tenant,user,{name:"Spend",filters:{},visibility:"tenant"});await s.createSchedule(tenant,{name:"Weekly",savedViewId:view.id,format:"csv",cadence:"weekly",timezone:"UTC",recipients:["ops@example.test"]});const destination=await s.createDestination(tenant,{kind:"webhook",label:"SIEM",emailRecipients:[],secret:"super-secret"});await s.createRule(tenant,{name:"Spend high",signal:"spend_threshold",enabled:true,threshold:100,windowMinutes:60,destinationIds:[destination.id]});expect(await s.listSchedules(tenant)).toHaveLength(1);expect((await s.listDestinations(tenant))[0]).toMatchObject({configured:true});expect(JSON.stringify(await s.listDestinations(tenant))).not.toContain("super-secret");const policy=await s.setAuthentication(tenant,{mfaRequired:true,sessionMaxAgeMinutes:60,idleTimeoutMinutes:15,trustedDevicesAllowed:false,allowedLoginMethods:["oidc"],allowedDomains:["example.test"],emergencyLocalOwnerEnabled:true});expect(policy.mfaRequired).toBe(true);});});

it("returns tenant profile defaults before an organization_profiles row exists",async()=>{
  const query=vi.fn(async(sql:string)=>sql.includes("FROM tenants t")?[{
    tenant_id:tenant,tenant_name:"Acme",tenant_slug:"acme",deployment_mode:"self-hosted",region:null,
    logo_url:null,timezone:"UTC",language:"en",support_email:null,security_email:null,announcements:[],
    terms_url:null,privacy_url:null,branding:{},updated_at:new Date("2026-08-04T00:00:00.000Z"),
  }]:[]);
  const database={withTenant:async(_tenantId:string,callback:(db:{query:typeof query})=>Promise<unknown>)=>callback({query})};
  const profile=await new PostgresManagementRepository(database as never).getProfile(tenant);
  expect(profile).toMatchObject({tenantId:tenant,name:"Acme",slug:"acme",timezone:"UTC",domains:[]});
});

it("rejects an oversized organization logo before updating the profile",async()=>{
  const execute=vi.fn(async()=>undefined);
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("SELECT id,media_type"))return [{id:"00000000-0000-7000-8000-000000000204",media_type:"image/png",detected_media_type:null,size_bytes:5*1024*1024+1,status:"available"}];
    return [];
  });
  const database={withTenant:async(_tenantId:string,callback:(db:{query:typeof query;execute:typeof execute})=>Promise<unknown>)=>callback({query,execute})};
  const repository=new PostgresManagementRepository(database as never);
  await expect(repository.setProfile(tenant,user,{
    name:"Acme",slug:"acme",logoUrl:null,timezone:"Asia/Dubai",language:"en",supportEmail:null,securityEmail:null,
    deploymentMode:"self-hosted",region:null,announcements:[],termsUrl:null,privacyUrl:null,
    branding:{logoFileId:"00000000-0000-7000-8000-000000000204"},
  })).rejects.toThrow("5 MB or smaller");
  expect(execute).not.toHaveBeenCalled();
});

it("allows another administrator to preserve the currently bound branding files",async()=>{
  const execute=vi.fn(async()=>undefined);
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("SELECT id,media_type"))return [{id:"00000000-0000-7000-8000-000000000204",media_type:"image/svg+xml",detected_media_type:null,size_bytes:512,status:"available"}];
    if(sql.includes("FROM tenants t"))return [{
      tenant_id:tenant,tenant_name:"Acme",tenant_slug:"acme",deployment_mode:"self-hosted",region:null,logo_url:null,timezone:"Asia/Dubai",language:"en",
      support_email:null,security_email:null,announcements:[],terms_url:null,privacy_url:null,branding:{logoFileId:"00000000-0000-7000-8000-000000000204"},updated_at:new Date("2026-08-10T00:00:00.000Z"),
    }];
    return [];
  });
  const database={withTenant:async(_tenantId:string,callback:(db:{query:typeof query;execute:typeof execute})=>Promise<unknown>)=>callback({query,execute})};
  const repository=new PostgresManagementRepository(database as never);
  await expect(repository.setProfile(tenant,user,{
    name:"Acme",slug:"acme",logoUrl:null,timezone:"Asia/Dubai",language:"en",supportEmail:null,securityEmail:null,
    deploymentMode:"self-hosted",region:null,announcements:[],termsUrl:null,privacyUrl:null,
    branding:{logoFileId:"00000000-0000-7000-8000-000000000204"},
  })).resolves.toMatchObject({name:"Acme",timezone:"Asia/Dubai"});
  const assetQuery=query.mock.calls.find(([sql])=>sql.includes("SELECT id,media_type"))?.[0];
  expect(assetQuery).toContain("profile.branding->>'logoFileId'");
  const profileLockQuery=query.mock.calls.find(([sql])=>sql.includes("FOR UPDATE OF tenant"))?.[0];
  expect(profileLockQuery).toContain("FROM tenants tenant");
  expect(execute).toHaveBeenCalled();
});
