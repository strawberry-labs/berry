import { describe, expect, it, vi } from "vitest";
import { applyDeploymentFavicon, authDestination, oauthErrorMessage, sanitizedAuthUrl } from "./auth-boundary.tsx";
import { deploymentBrandLogoUrl, resolveDeploymentBrandAssetUrl } from "./deployment-brand.tsx";
import { deploymentAccentTokens } from "./deployment-accent.ts";
import { googleSsoRequest } from "./google-sso-button.tsx";

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

describe("resolveDeploymentBrandAssetUrl", () => {
  it("resolves Berry branding paths against a separate API origin", () => {
    expect(resolveDeploymentBrandAssetUrl("https://api.example.test", "/v1/branding/logo?v=file"))
      .toBe("https://api.example.test/v1/branding/logo?v=file");
  });

  it("preserves an external legacy logo URL", () => {
    expect(resolveDeploymentBrandAssetUrl("https://api.example.test", "https://assets.example.test/logo.svg"))
      .toBe("https://assets.example.test/logo.svg");
  });
});

describe("deploymentBrandLogoUrl", () => {
  it("falls back to the Berry logo after a configured asset fails to load", () => {
    const logoUrl = "https://api.example.test/v1/branding/logo?v=legacy-svg";
    expect(deploymentBrandLogoUrl(logoUrl, null)).toBe(logoUrl);
    expect(deploymentBrandLogoUrl(logoUrl, logoUrl)).toBeNull();
  });
});

describe("applyDeploymentFavicon", () => {
  it("removes a failed organization icon so the browser can use its default", () => {
    const link = { rel: "", href: "", dataset: {} as Record<string, string>, onerror: null as null | (() => void), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal("document", {
      head: { querySelector: vi.fn(() => null), append },
      createElement: vi.fn(() => link),
    });
    try {
      applyDeploymentFavicon("https://api.example.test/v1/branding/favicon?v=invalid");
      expect(append).toHaveBeenCalledWith(link);
      link.onerror?.();
      expect(link.remove).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes a failed same-origin icon after the DOM normalizes its relative URL", () => {
    let normalizedHref = "";
    const link = {
      rel: "",
      dataset: {} as Record<string, string>,
      onerror: null as null | (() => void),
      remove: vi.fn(),
      get href() { return normalizedHref; },
      set href(value: string) { normalizedHref = new URL(value, "https://berry.example.test").href; },
    };
    const append = vi.fn();
    vi.stubGlobal("document", {
      head: { querySelector: vi.fn(() => null), append },
      createElement: vi.fn(() => link),
    });
    try {
      applyDeploymentFavicon("/v1/branding/favicon?v=invalid");
      expect(link.href).toBe("https://berry.example.test/v1/branding/favicon?v=invalid");
      link.onerror?.();
      expect(link.remove).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("googleSsoRequest", () => {
  it("uses the Better Auth Google provider without requesting connector scopes", () => {
    expect(googleSsoRequest("https://ai.aesg.com/")).toEqual({
      provider: "google",
      callbackURL: "https://ai.aesg.com/",
      errorCallbackURL: "https://ai.aesg.com/login",
      disableRedirect: true,
    });
  });
});

describe("OAuth callback errors", () => {
  it("maps known provider failures without exposing callback details", () => {
    expect(oauthErrorMessage({ error: "access_denied", error_description: "sensitive provider detail" }))
      .toBe("Google sign-in was cancelled.");
  });

  it("uses a safe fallback for unknown provider failures", () => {
    expect(oauthErrorMessage({ error: "internal_provider_error", error_description: "sensitive provider detail" }))
      .toBe("Google sign-in could not be completed. Please try again or contact the Berry owner.");
  });

  it("removes OAuth errors and setup secrets from the address bar", () => {
    expect(sanitizedAuthUrl("https://ai.aesg.com/login?next=%2F&error=access_denied&error_description=secret#setup=top-secret"))
      .toBe("/login?next=%2F");
  });
});

describe("deploymentAccentTokens", () => {
  it.each(["#ffffff", "#000000", "#ffea00", "#7c6df2"])("creates contrast-safe light and dark variants for %s", (color) => {
    const tokens = deploymentAccentTokens(color);
    expect(tokens?.light).toMatch(/^oklch\(/);
    expect(tokens?.dark).toMatch(/^oklch\(/);
    expect(tokens?.lightContrast).toBeGreaterThanOrEqual(4.599);
    expect(tokens?.darkContrast).toBeGreaterThanOrEqual(4.599);
  });

  it("rejects malformed accent values", () => {
    expect(deploymentAccentTokens("white")).toBeNull();
    expect(deploymentAccentTokens(null)).toBeNull();
  });
});
