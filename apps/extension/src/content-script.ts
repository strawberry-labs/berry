chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "berry.captureSelection") return false;
  sendResponse({
    title: document.title,
    selection: globalThis.getSelection?.()?.toString().trim() ?? "",
  });
  return true;
});
