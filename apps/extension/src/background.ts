import { captureCurrentPage } from "./page-capture";

const MENU_SEND_PAGE = "berry.sendPage";
const PENDING_PAGE_KEY = "berry.pendingPage";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_SEND_PAGE,
    title: "Send to Berry",
    contexts: ["page", "selection", "link"],
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "send-page-to-berry") void captureAndStorePage(false);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_SEND_PAGE) void captureAndStorePage(info.selectionText ? false : true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "berry.capturePage") {
    void captureAndStorePage(message.fullText === true).then((page) => sendResponse({ ok: true, page }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message?.type === "berry.consumePendingPage") {
    void chrome.storage.session.get(PENDING_PAGE_KEY).then(async (stored) => {
      await chrome.storage.session.remove(PENDING_PAGE_KEY);
      sendResponse({ page: stored[PENDING_PAGE_KEY] ?? null });
    });
    return true;
  }
  return false;
});

async function captureAndStorePage(fullText: boolean) {
  const page = await captureCurrentPage(chrome, { fullText });
  await chrome.storage.session.set({ [PENDING_PAGE_KEY]: page });
  await chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon.svg",
    title: "Berry captured this page",
    message: page.title,
  }).catch(() => undefined);
  return page;
}
