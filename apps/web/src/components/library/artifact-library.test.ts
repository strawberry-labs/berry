import { describe, expect, it } from "vitest";
import type { StoredFile, Workspace } from "@berry/shared";
import { libraryItemsForTab, projectFilterWorkspaces } from "./artifact-library";

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
	it("keeps project workspaces and excludes the general task workspace", () => {
		expect(projectFilterWorkspaces([workspace("project", "project"), workspace("general", "general")])).toEqual([
			workspace("project", "project"),
		]);
	});
});

describe("libraryItemsForTab", () => {
	it("preserves the API order when images and documents share All", () => {
		const files = [
			{ id: "document", mediaType: "application/pdf" },
			{ id: "image", mediaType: "image/png" },
			{ id: "active-image", name: "active.svg", mediaType: "image/svg+xml" },
			{ id: "sheet", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
		] as StoredFile[];
		expect(libraryItemsForTab(files, "all").map((file) => file.id)).toEqual(["document", "image", "active-image", "sheet"]);
		expect(libraryItemsForTab(files, "images").map((file) => file.id)).toEqual(["image"]);
		expect(libraryItemsForTab(files, "documents").map((file) => file.id)).toContain("active-image");
	});
});
