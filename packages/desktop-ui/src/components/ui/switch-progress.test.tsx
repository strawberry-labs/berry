import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Progress } from "./progress";
import { Switch } from "./switch";

describe("compact controls", () => {
  it("keeps an unchecked switch distinguishable in either theme", () => {
    const html = renderToStaticMarkup(<Switch checked={false} onCheckedChange={() => {}} />);

    expect(html).toContain("data-state=\"unchecked\"");
    expect(html).toContain("--berry-text-tertiary");
    expect(html).toContain("--berry-border-hover");
    expect(html).not.toContain("dark:data-[state=unchecked]");
  });

  it("clamps invalid progress values to the supported range", () => {
    expect(renderToStaticMarkup(<Progress value={150} />)).toContain("translateX(-0%)");
    expect(renderToStaticMarkup(<Progress value={-10} />)).toContain("translateX(-100%)");
  });
});
