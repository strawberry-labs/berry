import { describe, expect, it } from "vitest";
import {
  memberAccessStatusOptions,
  memberStatusUpdate,
} from "./member-administration.ts";

describe("member administration", () => {
  it("offers revocation actions for pending Google administrators", () => {
    expect(memberAccessStatusOptions("pending")).toEqual([
      { value: "pending", label: "Pending Google sign-in" },
      { value: "disabled", label: "Revoke and block" },
      { value: "deprovisioned", label: "Revoke and offboard" },
    ]);
  });

  it("omits an unchanged pending status but submits a selected revocation", () => {
    expect(memberStatusUpdate("pending", "pending")).toEqual({});
    expect(memberStatusUpdate("pending", "disabled")).toEqual({ status: "disabled" });
    expect(memberStatusUpdate("pending", "deprovisioned")).toEqual({ status: "deprovisioned" });
  });
});
