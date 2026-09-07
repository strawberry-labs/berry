import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SkillImportDialog } from "./skill-import-dialog";
vi.mock("./management-primitives", () => ({ ManagementDialog: ({ children }: any) => <div>{children}</div>, Button: (props: any) => <button {...props} />, Input: (props: any) => <input {...props} />, Textarea: (props: any) => <textarea {...props} /> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
describe("skill import", () => {
  it("locks duplicate submissions, reports progress and targets the selected member", async () => {
    let complete!: (value: { id: string }) => void;
    const client = { uploadFile: vi.fn((_file, options) => { options.onProgress({ ratio: .5 }); return new Promise<{ id: string }>((resolve) => { complete = resolve; }); }), installMemberSkillArchive: vi.fn().mockResolvedValue({}), deleteFile: vi.fn().mockResolvedValue({}) };
    const success = vi.fn(); let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<SkillImportDialog client={client as never} tenantId="tenant" ownerId="member" open onOpenChange={vi.fn()} onSuccess={success} />); });
    await act(async () => { renderer.root.findByType("input").props.onChange({ currentTarget: { files: [{ name: "large.skill", size: 20 * 1024 * 1024 }] } }); });
    let pending!: Promise<void>;
    await act(async () => { const submit = renderer.root.findByType("form").props.onSubmit; pending = submit({ preventDefault: vi.fn() }); void submit({ preventDefault: vi.fn() }); });
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ role: "progressbar" }).props["aria-valuenow"]).toBe(50);
    await act(async () => { complete({ id: "uploaded" }); await pending; });
    expect(client.installMemberSkillArchive).toHaveBeenCalledWith("tenant", "member", "uploaded");
    expect(success).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
  it("releases the submission lock after an error so the user can retry", async () => {
    const client = { savePersonalSkill: vi.fn().mockRejectedValueOnce(new Error("Invalid skill metadata")).mockResolvedValueOnce({}) };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<SkillImportDialog client={client as never} tenantId="tenant" open onOpenChange={vi.fn()} onSuccess={vi.fn()} />); });
    await act(async () => { renderer.root.findAllByType("button")[1]!.props.onClick(); });
    await act(async () => { renderer.root.findByType("textarea").props.onChange({ target: { value: "instructions" } }); });
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Invalid skill metadata");
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault: vi.fn() }); });
    expect(client.savePersonalSkill).toHaveBeenCalledTimes(2);
    await act(async () => renderer.unmount());
  });

});
