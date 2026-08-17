export const SUPPORT_VIEW_STORAGE_KEY = "berry.web.supportView";
export const SUPPORT_VIEW_EVENT = "berry:support-view-changed";

export type SupportViewSubject = {
  tenantId: string;
  userId: string;
  name: string;
  email: string;
};

type StoredSupportView = SupportViewSubject & {
  actorUserId: string;
};

export function readSupportView(actorUserId: string | null | undefined): SupportViewSubject | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SUPPORT_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSupportView>;
    if (
      typeof value.tenantId !== "string"
      || typeof value.userId !== "string"
      || typeof value.name !== "string"
      || typeof value.email !== "string"
      || typeof value.actorUserId !== "string"
      || !actorUserId
      || value.actorUserId !== actorUserId
    ) {
      removeStoredSupportView();
      return null;
    }
    return {
      tenantId: value.tenantId,
      userId: value.userId,
      name: value.name,
      email: value.email,
    };
  } catch {
    removeStoredSupportView();
    return null;
  }
}

export function startSupportView(subject: SupportViewSubject, actorUserId: string): void {
  try {
    window.localStorage.setItem(SUPPORT_VIEW_STORAGE_KEY, JSON.stringify({ ...subject, actorUserId } satisfies StoredSupportView));
  } catch {
    throw new Error("Support view could not be started because browser storage is unavailable.");
  }
  window.dispatchEvent(new Event(SUPPORT_VIEW_EVENT));
}

export function stopSupportView(): void {
  removeStoredSupportView();
  window.dispatchEvent(new Event(SUPPORT_VIEW_EVENT));
}

function removeStoredSupportView(): void {
  try {
    window.localStorage.removeItem(SUPPORT_VIEW_STORAGE_KEY);
  } catch {
    // A blocked storage API must not strand the authenticated shell or prevent sign-out.
  }
}
