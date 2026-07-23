import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import type { RouterAccount, RouterContractStatus } from "@berry/shared";
import { Globe, Palette, Plug, RefreshCw, Route, ZoomIn } from "@berry/desktop-ui/lib/icons";
import { Button } from "@berry/desktop-ui/components/ui/button";
import { CircularActivitySpinner } from "@berry/desktop-ui/components/ui/circular-activity-spinner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@berry/desktop-ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@berry/desktop-ui/components/ui/dropdown-menu";
import { Input } from "@berry/desktop-ui/components/ui/input";
import { Label } from "@berry/desktop-ui/components/ui/label";
import { Progress } from "@berry/desktop-ui/components/ui/progress";
import { toast } from "sonner";
import { host } from "@/lib/berry";
import { BerryLogo } from "@/components/berry-logo";
import { openRouterAuthorization, subscribeRouterCallbacks } from "@/lib/router-auth";

const ZOOM_LEVELS = [90, 100, 110, 125] as const;
const BASE_FONT_PX = 16;

/** The whole UI is sized in rem, so zoom is just the root font size. */
function applyZoom(percent: number) {
  document.documentElement.style.fontSize = `${(BASE_FONT_PX * percent) / 100}px`;
}

export function ConnectMenu({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme();
  const queryClient = useQueryClient();
  const [connectOpen, setConnectOpen] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const { data: language } = useQuery({
    queryKey: ["settings", "ui.language"],
    queryFn: () => host.call<string | null>("settings.get", { key: "ui.language" }),
  });
  const { data: zoom } = useQuery({
    queryKey: ["settings", "ui.zoom"],
    queryFn: () => host.call<number | null>("settings.get", { key: "ui.zoom" }),
  });
  const credential = useQuery({
    queryKey: ["credential", "berry-router"],
    queryFn: () => host.call<{ exists: boolean; hint: string | null }>("credential.status", { reference: "berry-router" }),
    enabled: connectOpen,
  });
  const routerContract = useQuery({
    queryKey: ["router", "contract"],
    queryFn: () => host.call<RouterContractStatus>("router.contract.status"),
    enabled: connectOpen,
  });
  const routerAccount = useQuery({
    queryKey: ["router", "account"],
    queryFn: () => host.call<RouterAccount>("router.account.get", { providerId: "berry-router", credentialRef: "berry-router" }),
    enabled: connectOpen && credential.data?.exists === true,
    retry: false,
  });

  // Re-apply the persisted zoom once loaded so the radio state and the actual
  // root font size can never disagree.
  useEffect(() => {
    if (typeof zoom === "number") applyZoom(zoom);
  }, [zoom]);

  useEffect(() => {
    if (!connectOpen) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribeRouterCallbacks((callback) => {
      setSigningIn(true);
      void host.call<{ accessToken: string; tokenType: string; expiresAt: string | null }>("router.oauth.exchange", callback)
        .then((result) => host.call("credential.set", { reference: "berry-router", secret: result.accessToken }))
        .then(async () => {
          await queryClient.invalidateQueries({ queryKey: ["credential", "berry-router"] });
          await queryClient.invalidateQueries({ queryKey: ["router", "account"] });
          toast.success("Berry Router connected");
        })
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Berry Router sign-in failed"))
        .finally(() => setSigningIn(false));
    }).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Could not listen for Berry Router sign-in"));
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [connectOpen, queryClient]);

  const setSetting = async (key: string, value: string | number) => {
    try {
      await host.call("settings.set", { key, value });
      await queryClient.invalidateQueries({ queryKey: ["settings", key] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not save ${key}`);
    }
  };

  const saveToken = async () => {
    setSaving(true);
    try {
      await host.call("credential.set", { reference: "berry-router", secret: token.trim() });
      await queryClient.invalidateQueries({ queryKey: ["credential", "berry-router"] });
      await queryClient.invalidateQueries({ queryKey: ["router", "account"] });
      toast.success("Berry Router connected");
      setToken("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the token");
    } finally {
      setSaving(false);
    }
  };

  const startOAuth = async () => {
    setSigningIn(true);
    try {
      const result = await host.call("router.oauth.start", { redirectUri: routerContract.data?.redirectUri });
      await openRouterAuthorization(result.authorizationUrl);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start Berry Router sign-in");
      setSigningIn(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await host.call("credential.delete", { reference: "berry-router" });
      await queryClient.invalidateQueries({ queryKey: ["credential", "berry-router"] });
      queryClient.removeQueries({ queryKey: ["router", "account"] });
      toast.success("Berry Router disconnected");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem className="items-start gap-3 py-2" onSelect={() => setConnectOpen(true)}>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <BerryLogo className="size-full" alt="" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">Berry Router</span>
              <span className="text-xs text-muted-foreground">Models, routing, and quota</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Globe className="size-4 text-muted-foreground" />
              Language
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={language ?? "system"}
                onValueChange={(value) => void setSetting("ui.language", value)}
              >
                <DropdownMenuRadioItem value="system">System default</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <Palette className="size-4 text-muted-foreground" />
              App theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2">
              <ZoomIn className="size-4 text-muted-foreground" />
              Interface zoom
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={String(zoom ?? 100)}
                onValueChange={(value) => {
                  const percent = Number(value);
                  applyZoom(percent);
                  void setSetting("ui.zoom", percent);
                }}
              >
                {ZOOM_LEVELS.map((level) => (
                  <DropdownMenuRadioItem key={level} value={String(level)}>
                    {level}%
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Berry Router</DialogTitle>
            <DialogDescription>
              Connect the managed model gateway. Credentials stay encrypted on this device.
            </DialogDescription>
          </DialogHeader>
          {credential.data?.exists && routerAccount.data ? (
            <div className="grid gap-4 rounded-md border border-border p-4" data-testid="router-account-card">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{routerAccount.data.displayName ?? routerAccount.data.email ?? routerAccount.data.id}</p>
                  <p className="text-xs text-muted-foreground">{routerAccount.data.plan} plan · {credential.data.hint}</p>
                </div>
                <Route className="size-4 shrink-0 text-emerald-500" />
              </div>
              <div className="grid gap-2">
                <div className="flex justify-between gap-4 text-xs">
                  <span className="text-muted-foreground">Quota used</span>
                  <span className="tabular-nums">{routerAccount.data.quota.used} {routerAccount.data.quota.unit}</span>
                </div>
                {routerAccount.data.quota.limit !== null ? (
                  <Progress value={Math.min(100, (routerAccount.data.quota.used / Math.max(1, routerAccount.data.quota.limit)) * 100)} className="h-1.5" />
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{routerAccount.data.aliases.join(" · ")}</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {routerContract.data?.oauthAvailable ? (
                <Button onClick={() => void startOAuth()} disabled={signingIn}>
                  {signingIn ? <CircularActivitySpinner size={16} label="Signing in" /> : <Plug />}
                  Sign in with Berry Router
                </Button>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="berry-router-token">API key</Label>
                <Input
                  id="berry-router-token"
                  type="password"
                  autoComplete="off"
                  placeholder="brry_..."
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && token.trim() && !saving) void saveToken();
                  }}
                />
              </div>
              {credential.data?.exists && routerAccount.isError ? (
                <p className="text-sm text-destructive">The saved credential could not load the Router account.</p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Close</Button>
            </DialogClose>
            {credential.data?.exists ? (
              <Button variant="destructive" disabled={saving} onClick={() => void disconnect()}>Disconnect</Button>
            ) : (
              <Button disabled={!token.trim() || saving} onClick={() => void saveToken()}>
                {saving ? "Saving..." : "Save key"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
