import { describe, expect, it } from "vitest";
import { authDestination } from "./auth-boundary.tsx";

describe("authDestination", () => {
  it("replaces signed-out task URLs with the login route", () => {
    expect(authDestination({
      authenticated: false,
      loading: false,
      pathname: "/tasks/task-from-another-user",
    })).toBe("/login");
  });

  it("keeps the login route stable while signed out", () => {
    expect(authDestination({
      authenticated: false,
      loading: false,
      pathname: "/login",
    })).toBeNull();
  });

  it("returns a newly signed-in user to the workspace home", () => {
    expect(authDestination({
      authenticated: true,
      loading: false,
      pathname: "/login",
    })).toBe("/");
  });
});
