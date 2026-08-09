import { describe, expect, it } from "vitest";
import { s3ClientOptions } from "./s3-client-options.js";

describe("s3ClientOptions", () => {
  it("leaves credentials unresolved for an EC2 instance role", () => {
    expect(s3ClientOptions({ region: "eu-west-1" })).toEqual({ region: "eu-west-1" });
  });

  it("rejects a partial static credential pair", () => {
    expect(() => s3ClientOptions({ secretAccessKey: "secret" })).toThrow("configured together");
  });
});
