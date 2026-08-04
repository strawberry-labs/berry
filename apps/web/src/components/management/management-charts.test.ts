import { describe, expect, it } from "vitest";
import { aggregateModelSpendRows } from "./management-charts";

describe("aggregateModelSpendRows", () => {
  it("keeps the leading models and combines the remainder into Other", () => {
    expect(aggregateModelSpendRows([
      { label: "Model C", value: 30 },
      { label: "Model A", value: 50 },
      { label: "Model F", value: 5 },
      { label: "Model B", value: 40 },
      { label: "Model E", value: 10 },
      { label: "Model D", value: 20 },
    ])).toEqual([
      { label: "Model A", value: 50 },
      { label: "Model B", value: 40 },
      { label: "Model C", value: 30 },
      { label: "Model D", value: 20 },
      { label: "Other", value: 15 },
    ]);
  });

  it("drops zero-value models without adding an Other row", () => {
    expect(aggregateModelSpendRows([
      { label: "Model A", value: 8 },
      { label: "Unused", value: 0 },
    ])).toEqual([{ label: "Model A", value: 8 }]);
  });
});
