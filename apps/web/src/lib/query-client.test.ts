import { describe, expect, it } from "vitest";
import { managementQueryKeys } from "./management-query-keys";
import { createWebQueryClient } from "./query-client";

describe("web query client isolation", () => {
  it("does not share management data between authenticated shell instances", () => {
    const first = createWebQueryClient();
    const second = createWebQueryClient();
    const key = managementQueryKeys.resource("connectors:me");

    first.setQueryData(key, [{ id: "private-connector" }]);

    expect(second.getQueryData(key)).toBeUndefined();
    first.clear();
    second.clear();
  });
});
