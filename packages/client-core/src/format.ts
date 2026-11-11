import type { AllowanceBalance } from "@berry/shared";

/** Display formatting shared by the web and native sidebars and account surfaces. */

export function formatCurrencyMicros(value: string | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) / 1_000_000);
}

export function allowanceProgress(allowance: AllowanceBalance): number {
  if (!allowance.effectiveLimitMicros || allowance.effectiveLimitMicros === "0") return 0;
  const consumed = Number(allowance.usedMicros) + Number(allowance.reservedMicros);
  return Math.min(100, (consumed / Number(allowance.effectiveLimitMicros)) * 100);
}

export function accountAvatarInitial(user: { name?: string | null; email?: string | null } | null): string {
  return (user?.name?.trim()[0] || user?.email?.trim()[0] || "?").toUpperCase();
}

export function formatAllowanceResetDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function timeAgo(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
