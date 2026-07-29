import { describe, expect, it } from "vitest";
import type { Workspace } from "@berry/shared";
import { projectFilterWorkspaces } from "./artifact-library";

const workspace = (id: string, workspaceKind: Workspace["workspaceKind"]): Workspace => ({
	id,
	path: `/workspace/${id}`,
	name: id,
	workspaceKind,
	ownerUserId: null,
	trustState: "trusted",
	lastOpenedAt: "2026-07-29T00:00:00.000Z",
	indexedAt: null,
	createdAt: "2026-07-29T00:00:00.000Z",
	updatedAt: "2026-07-29T00:00:00.000Z",
	pinned: false,
});

describe("projectFilterWorkspaces", () => {
	it("keeps project workspaces and excludes the general chat workspace", () => {
		expect(projectFilterWorkspaces([workspace("project", "project"), workspace("general", "general")])).toEqual([
			workspace("project", "project"),
		]);
	});
});
