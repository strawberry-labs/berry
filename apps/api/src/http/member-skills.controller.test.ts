import { describe, it, expect, vi } from "vitest";
import { MemberSkillsController } from "./member-skills.controller.ts";
function setup(allowed = true, member = true) {
  const skills = { listSkills: vi.fn().mockResolvedValue([]), deleteSkill: vi.fn().mockResolvedValue({ ok: true }) };
  const identity = { authorize: vi.fn().mockResolvedValue(allowed), getMembership: vi.fn().mockResolvedValue(member ? {} : null) };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const organization = { effective: vi.fn().mockResolvedValue({ rows: [] }) };
  return { skills, identity, audit, controller: new MemberSkillsController(skills as never, organization as never, identity as never, audit as never, {} as never) };
}
const req = { auth: { user: { id: "admin" } } } as never;
describe("member skill administration", () => {
  it("refuses non-administrators before reading another user's skills", async () => {
    const { controller, skills } = setup(false);
    await expect(controller.list(req, "tenant", "member")).rejects.toThrow("administrator permission");
    expect(skills.listSkills).not.toHaveBeenCalled();
  });
  it("requires membership in the requested organization", async () => {
    const { controller, skills } = setup(true, false);
    await expect(controller.remove(req, "tenant", "outsider", "skill")).rejects.toThrow("member not found");
    expect(skills.deleteSkill).not.toHaveBeenCalled();
  });
  it("deletes only the target owner's skill and audits the administrator separately", async () => {
    const { controller, skills, identity, audit } = setup();
    await controller.remove(req, "tenant", "member", "skill");
    expect(identity.authorize).toHaveBeenCalledWith("admin", "tenant", "skills:write");
    expect(skills.deleteSkill).toHaveBeenCalledWith("tenant", "member", "skill");
    expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "admin", metadata: { ownerUserId: "member" } }));
  });
});
