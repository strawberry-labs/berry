import { useState } from "react";
import { useTheme } from "next-themes";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileDown, Monitor, Moon, RefreshCw, Sun } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { Input } from "@berry/desktop-ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@berry/desktop-ui/components/ui/select";
import {
  SettingCard,
  SettingRow,
  SettingsPageHeader,
  SwitchSettingRow,
  TextSettingRow,
  useSetSetting,
  useStringSetting,
} from "./shared";
import { host } from "@/lib/berry";
import { toast } from "sonner";

const THEME_OPTIONS = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
] as const;

interface UpdaterStatus {
  status: "development" | "not-configured" | "current" | "available" | "error";
  feed: string;
  configured: boolean;
  endpoint?: string;
  signingKeyPresent?: boolean;
  currentVersion?: string;
  version?: string;
  date?: string | null;
  body?: string | null;
  rolloutEligible?: boolean;
  error?: string;
}

function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const persist = useSetSetting("ui.theme");
  const current = THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[0];

  return (
    <Select
      value={current.value}
      onValueChange={(value) => {
        setTheme(value);
        persist.mutate(value);
      }}
    >
      <SelectTrigger className="w-40" aria-label="App theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {THEME_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <option.icon className="size-4 text-muted-foreground" />
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function LanguageSelect() {
  const { value, set } = useStringSetting("ui.language", "system");
  return (
    <Select value={value} onValueChange={set}>
      <SelectTrigger className="w-40" aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="system">System default</SelectItem>
        <SelectItem value="en">English</SelectItem>
      </SelectContent>
    </Select>
  );
}

function WebSearchSettings() {
  const queryClient = useQueryClient();
  const { value: provider, set: setProvider } = useStringSetting("web.search.provider", "none");
  const [apiKey, setApiKey] = useState("");
  const credentialRef = provider === "brave" || provider === "tavily" || provider === "ollama" ? `web-search-${provider}` : null;
  const credential = useQuery({
    queryKey: ["credential.status", credentialRef],
    queryFn: () => host.call<{ exists: boolean }>("credential.status", { reference: credentialRef! }),
    enabled: credentialRef !== null,
  });
  const saveKey = async () => {
    if (!credentialRef || !apiKey.trim()) return;
    try {
      await host.call("credential.set", { reference: credentialRef, secret: apiKey.trim() });
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: ["credential.status", credentialRef] });
      toast.success("Saved web search API key");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save web search API key");
    }
  };
  const deleteKey = async () => {
    if (!credentialRef) return;
    await host.call("credential.delete", { reference: credentialRef });
    await queryClient.invalidateQueries({ queryKey: ["credential.status", credentialRef] });
  };

  return (
    <>
      <SettingRow
        title="Web search provider"
        description="Choose the provider used by the agent's web_search tool."
        control={
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-44" aria-label="Web search provider"><SelectValue /></SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="none">Disabled</SelectItem>
              <SelectItem value="brave">Brave Search</SelectItem>
              <SelectItem value="tavily">Tavily</SelectItem>
              <SelectItem value="searxng">SearXNG</SelectItem>
              <SelectItem value="ollama">Ollama hosted search</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {credentialRef ? (
        <SettingRow
          title={`${provider === "ollama" ? "Ollama hosted search" : provider === "brave" ? "Brave Search" : "Tavily"} API key`}
          description={credential.data?.exists ? "An encrypted API key is saved." : "The key is stored by the desktop credential service, not in Berry settings."}
          control={credential.data?.exists ? <Button size="sm" variant="secondary" onClick={() => void deleteKey()}>Delete</Button> : null}
        >
          <div className="flex gap-2">
            <Input
              type="password"
              value={apiKey}
              aria-label="Web search API key"
              placeholder={credential.data?.exists ? "Replace saved key" : "Paste API key"}
              className="font-mono text-xs"
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void saveKey(); }}
            />
            <Button size="sm" variant="secondary" disabled={!apiKey.trim()} onClick={() => void saveKey()}>Save</Button>
          </div>
        </SettingRow>
      ) : null}
      {provider === "searxng" ? (
        <TextSettingRow
          title="SearXNG instance URL"
          description="Use an instance with JSON output enabled. Local and self-hosted URLs are supported for this configured provider."
          settingKey="web.search.searxngUrl"
          placeholder="e.g. https://search.example.com"
          mono
        />
      ) : null}
      <TextSettingRow
        title="Private fetch allowlist"
        description="Comma-separated hostnames that fetch_url may access despite resolving to a private address. Wildcards such as *.internal.example are supported."
        settingKey="web.fetch.privateAllowlist"
        placeholder="e.g. docs.internal.example,*.corp.example"
        mono
      />
    </>
  );
}

function UpdaterSettings() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["updater.status"],
    queryFn: () => host.call<UpdaterStatus>("updater.status", {}),
  });
  const install = useMutation({
    mutationFn: () => host.call<{ installed: boolean; status: string; version?: string; error?: string }>("updater.install", {}),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["updater.status"] });
      if (result.installed) toast.success("Update installed", { description: "Restart Berry to finish." });
      else if (result.status === "current") toast.success("Berry is up to date");
      else toast.error(result.error ?? "Updater is not configured");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not install update"),
  });
  const data = status.data;
  const label =
    data?.status === "available"
      ? `Version ${data.version} available`
      : data?.status === "current"
        ? "Berry is up to date"
        : data?.status === "development"
          ? "Development build"
          : data?.status === "error"
            ? "Update check failed"
            : "Updater not configured";
  const description =
    data?.status === "available"
      ? data.body ?? "A signed update is ready to install."
      : data?.endpoint
        ? `Feed: ${data.endpoint}`
        : "Signed releases are enabled after the production updater key and release feed are supplied.";

  return (
    <SettingRow
      title="Signed updates"
      description={description}
      control={
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" aria-label="Check for updates" disabled={status.isFetching} onClick={() => void status.refetch()}>
            <RefreshCw className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={data?.status !== "available" || install.isPending}
            onClick={() => install.mutate()}
          >
            <FileDown className="size-4" />
            Install
          </Button>
        </div>
      }
    >
      <div className="text-xs text-muted-foreground">{label}</div>
    </SettingRow>
  );
}

export function GeneralSettings() {
  return (
    <div className="flex flex-col gap-6">
      <SettingsPageHeader title="General" />

      <SettingCard>
        <SettingRow
          title="App theme"
          description="Choose which theme the application interface should use."
          control={<ThemeSelect />}
        />
        <SettingRow
          title="Language"
          description="Choose the display language used by the application UI."
          control={<LanguageSelect />}
        />
        <UpdaterSettings />
      </SettingCard>

      <SettingCard>
        <SwitchSettingRow
          title="Workspace sandbox network"
          description="Allow network access for Ask and Auto-edit commands, browser tools, web fetches, and remote MCP servers. Plan stays offline; Full access skips this toggle but still honors the domain allowlist."
          settingKey="sandbox.workspaceWrite.network"
          defaultValue={false}
        />
        <TextSettingRow
          title="Network domain allowlist"
          description="Optional comma-separated domains for browser, web, and remote MCP traffic. Use *.example.com for subdomains. Empty allows any public domain when egress is on."
          settingKey="network.domainAllowlist"
          placeholder="e.g. api.example.com,*.docs.example.com"
          mono
        />
      </SettingCard>

      <SettingCard>
        <SwitchSettingRow
          title="Inherit system terminal profile"
          description="When launching the built-in terminal, inherit login shell environment, proxy variables, and local terminal font when possible."
          settingKey="terminal.inheritProfile"
          defaultValue={true}
        />
        <TextSettingRow
          title="Terminal font"
          description="Leave blank to auto-detect system terminal settings; set a value to override the Berry terminal font."
          settingKey="terminal.font"
          placeholder="Leave blank to inherit, e.g. MesloLGS NF, monospace"
          mono
        />
      </SettingCard>

      <SettingCard>
        <TextSettingRow
          title="HTTP Proxy"
          description="Route model, MCP, and command-tool egress traffic through this proxy. Leave blank for direct connections. Restart the app to take effect."
          settingKey="network.proxy"
          placeholder="Leave blank for direct, e.g. http://127.0.0.1:7890"
          mono
        />
        <TextSettingRow
          title="No proxy"
          description="Comma-separated hosts that bypass the proxy."
          settingKey="network.noProxy"
          placeholder="e.g. localhost,127.0.0.1,.internal"
          mono
        />
      </SettingCard>

      <SettingCard>
        <WebSearchSettings />
      </SettingCard>

      <SettingCard>
        <SwitchSettingRow
          title="Queue messages"
          description="Messages sent while Berry is still working are queued and delivered on the next turn instead of interrupting."
          settingKey="composer.queueMessages"
          defaultValue={true}
        />
        <SwitchSettingRow
          title="Show reasoning"
          description="Show the model's reasoning summaries inline in the thread."
          settingKey="thread.showReasoning"
          defaultValue={true}
        />
        <SwitchSettingRow
          title="Show todos"
          description="Show the agent's running todo list while it works through a task."
          settingKey="thread.showTodos"
          defaultValue={true}
        />
      </SettingCard>

      <SettingCard>
        <TextSettingRow
          title="Default working directory"
          description="New workspaces open from this directory by default."
          settingKey="workspace.defaultDirectory"
          placeholder="e.g. ~/Projects"
          mono
        />
      </SettingCard>

      <SettingCard>
        <SwitchSettingRow
          title="Help improve Berry"
          description="Share anonymous usage data and crash reports. No code, prompts, or file contents ever leave this machine."
          settingKey="telemetry.enabled"
          defaultValue={false}
        />
      </SettingCard>
    </div>
  );
}
