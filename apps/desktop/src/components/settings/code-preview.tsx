import { useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Badge } from "@berry/desktop-ui/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@berry/desktop-ui/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import { Slider } from "@berry/desktop-ui/components/ui/slider";
import { cn } from "@berry/desktop-ui/lib/utils";
import {
  SettingCard,
  SettingRow,
  SettingsPageHeader,
  SwitchSettingRow,
  useBooleanSetting,
  useNumberSetting,
  useStringSetting,
} from "./shared";

const LIGHT_THEMES = [
  { value: "berry-light", label: "Berry Light" },
  { value: "github-light", label: "GitHub Light" },
] as const;

const DARK_THEMES = [
  { value: "berry-dark", label: "Berry Dark" },
  { value: "one-dark", label: "One Dark" },
] as const;

function ThemeSettingRow({
  title,
  description,
  settingKey,
  options,
  fallback,
}: {
  title: string;
  description: string;
  settingKey: string;
  options: readonly { value: string; label: string }[];
  fallback: string;
}) {
  const { value, set } = useStringSetting(settingKey, fallback);
  return (
    <SettingRow
      title={title}
      description={description}
      control={
        <Select value={value} onValueChange={set}>
          <SelectTrigger className="w-44" aria-label={title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

function FontSizeRow() {
  const { value, set } = useNumberSetting("codePreview.fontSize", 13);
  const [draft, setDraft] = useState<number | null>(null);
  const size = draft ?? value;
  return (
    <SettingRow
      title="Code font size"
      description="Adjust the default font size used by code previews."
      control={
        <span className="w-8 text-right text-sm font-medium tabular-nums" aria-hidden>
          {size}
        </span>
      }
    >
      <Slider
        min={10}
        max={18}
        step={1}
        value={[size]}
        aria-label="Code font size"
        onValueChange={(next) => setDraft(next[0] ?? size)}
        onValueCommit={(next) => {
          setDraft(null);
          set(next[0] ?? size);
        }}
      />
    </SettingRow>
  );
}

/* A short, statically highlighted TypeScript snippet for the live preview. */
const SNIPPET_LINES: ReactNode[][] = [
  [
    <span key="k" className="text-chart-3">const</span>,
    " ",
    <span key="n" className="text-foreground">themePreview</span>,
    <span key="p" className="text-muted-foreground">:</span>,
    " ",
    <span key="t" className="text-chart-1">ThemeConfig</span>,
    " ",
    <span key="e" className="text-muted-foreground">=</span>,
    " ",
    <span key="b" className="text-muted-foreground">{"{"}</span>,
  ],
  [
    "  surface",
    <span key="p" className="text-muted-foreground">:</span>,
    " ",
    <span key="s" className="text-chart-1">&quot;sidebar&quot;</span>,
    <span key="c" className="text-muted-foreground">,</span>,
  ],
  [
    "  accent",
    <span key="p" className="text-muted-foreground">:</span>,
    " ",
    <span key="s" className="text-chart-1">&quot;oklch(0.68 0.1 163)&quot;</span>,
    <span key="c" className="text-muted-foreground">,</span>,
  ],
  [
    "  contrast",
    <span key="p" className="text-muted-foreground">:</span>,
    " ",
    <span key="n" className="text-chart-2">45</span>,
    <span key="c" className="text-muted-foreground">,</span>,
  ],
  [
    <span key="b" className="text-muted-foreground">{"}"};</span>,
  ],
];

function LivePreview() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const light = useStringSetting("codePreview.lightTheme", "berry-light");
  const dark = useStringSetting("codePreview.darkTheme", "berry-dark");
  const lineNumbers = useBooleanSetting("codePreview.lineNumbers", true);
  const wordWrap = useBooleanSetting("codePreview.wordWrap", false);
  const { value: fontSize } = useNumberSetting("codePreview.fontSize", 13);

  const activeValue = isDark ? dark.value : light.value;
  const activeLabel =
    [...LIGHT_THEMES, ...DARK_THEMES].find((option) => option.value === activeValue)?.label ?? activeValue;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Live preview</h2>
        <p className="text-sm text-muted-foreground">
          The code viewer automatically switches to the matching theme for the current app mode.
        </p>
      </div>
      <Card className="gap-4 rounded-xl border-border py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm">{isDark ? "Dark preview" : "Light preview"}</CardTitle>
          <CardDescription>{activeLabel}</CardDescription>
          <CardAction>
            <Badge variant="secondary">{isDark ? "Dark" : "Light"}</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="px-4">
          <pre
            className={cn(
              "overflow-x-auto rounded-lg border border-border bg-muted/40 p-4 font-mono leading-relaxed",
              wordWrap.value && "whitespace-pre-wrap break-words",
            )}
            style={{ fontSize: `${fontSize}px` }}
          >
            <code>
              {SNIPPET_LINES.map((line, index) => (
                <span key={index} className="flex gap-4">
                  {lineNumbers.value ? (
                    <span className="w-5 shrink-0 text-right text-muted-foreground/60 select-none" aria-hidden>
                      {index + 1}
                    </span>
                  ) : null}
                  <span className="min-w-0">{line}</span>
                </span>
              ))}
            </code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export function CodePreviewSettings() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title="Code preview" />

      <SettingCard>
        <ThemeSettingRow
          title="Light code theme"
          description="Theme used for code blocks while the interface is in light mode."
          settingKey="codePreview.lightTheme"
          options={LIGHT_THEMES}
          fallback="berry-light"
        />
        <ThemeSettingRow
          title="Dark code theme"
          description="Theme used for code blocks while the interface is in dark mode."
          settingKey="codePreview.darkTheme"
          options={DARK_THEMES}
          fallback="berry-dark"
        />
        <SwitchSettingRow
          title="Show line numbers"
          description="Display line numbers in code previews."
          settingKey="codePreview.lineNumbers"
          defaultValue={true}
        />
        <SwitchSettingRow
          title="Wrap long lines"
          description="Wrap long content inside the preview area automatically."
          settingKey="codePreview.wordWrap"
          defaultValue={false}
        />
        <FontSizeRow />
      </SettingCard>

      <LivePreview />
    </div>
  );
}
