import { describe, expect, it } from "vitest";
import {
  googleSsoCallbackPath,
  normalizeGoogleSsoCallbackRequestUrl,
  resolveGoogleSsoRedirectUri,
} from "./google-sso-callback.ts";

describe("Google SSO callback configuration", () => {
  it("keeps the standard callback when no enterprise override is configured", () => {
    const env = { BERRY_AUTH_BASE_URL: "https://ai.example.com" };

    expect(resolveGoogleSsoRedirectUri(env)).toBe("https://ai.example.com/v1/auth/callback/google");
    expect(googleSsoCallbackPath(env)).toBe("/v1/auth/callback/google");
  });

  it("accepts an enterprise SSO callback below the public auth route", () => {
    const env = {
      NODE_ENV: "production",
      BERRY_AUTH_BASE_URL: "https://ai.aesg.com",
      BERRY_AUTH_GOOGLE_REDIRECT_URI: "https://ai.aesg.com/v1/auth/sso/callback/aesg",
    };

    expect(resolveGoogleSsoRedirectUri(env)).toBe("https://ai.aesg.com/v1/auth/sso/callback/aesg");
    expect(googleSsoCallbackPath(env)).toBe("/v1/auth/sso/callback/aesg");
  });

  it("maps an enterprise callback to Better Auth's internal Google handler", () => {
    expect(normalizeGoogleSsoCallbackRequestUrl(
      "/v1/auth/sso/callback/aesg?code=oauth-code&state=oauth-state",
      "/v1/auth/sso/callback/aesg",
    )).toBe("/v1/auth/callback/google?code=oauth-code&state=oauth-state");
  });

  it("rejects callbacks that could leave the configured Berry auth origin", () => {
    expect(() => resolveGoogleSsoRedirectUri({
      NODE_ENV: "production",
      BERRY_AUTH_BASE_URL: "https://ai.example.com",
      BERRY_AUTH_GOOGLE_REDIRECT_URI: "https://attacker.example/v1/auth/sso/callback/acme",
    })).toThrow("same origin");
    expect(() => resolveGoogleSsoRedirectUri({
      NODE_ENV: "production",
      BERRY_AUTH_BASE_URL: "https://ai.example.com",
      BERRY_AUTH_GOOGLE_REDIRECT_URI: "https://ai.example.com/oauth/callback",
    })).toThrow("path under /v1/auth/");
  });
});
