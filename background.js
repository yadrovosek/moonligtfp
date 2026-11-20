const ALARM_NAME = "moonlightfp-refresh";
const MIN_INTERVAL_MINUTES = 240;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(["enabled", "intervalMinutes"]);
  await chrome.storage.local.set({
    enabled: current.enabled ?? false,
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, current.intervalMinutes ?? MIN_INTERVAL_MINUTES),
    lastRun: null,
    lastResult: "Готово к настройке"
  });
  await schedule();
});

chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const { enabled } = await chrome.storage.local.get("enabled");
  if (!enabled) return;
  await runOnActiveFunPayTab();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MOONLIGHTFP_RESULT") {
    chrome.storage.local.set({ lastRun: Date.now(), lastResult: message.text });
    return;
  }
  if (message?.type === "MOONLIGHTFP_RUN_NOW") {
    runOnActiveFunPayTab().then(sendResponse);
    return true;
  }
  if (message?.type === "MOONLIGHTFP_STATS_NOW") {
    loadStatsOnActiveFunPayTab().then(sendResponse);
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.enabled || changes.intervalMinutes)) schedule();
});

async function schedule() {
  const { enabled, intervalMinutes } = await chrome.storage.local.get(["enabled", "intervalMinutes"]);
  await chrome.alarms.clear(ALARM_NAME);
  if (enabled) {
    const period = Math.max(MIN_INTERVAL_MINUTES, Number(intervalMinutes) || MIN_INTERVAL_MINUTES);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: period, periodInMinutes: period });
  }
}

async function runOnActiveFunPayTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const funPayTabs = await chrome.tabs.query({ url: "https://funpay.com/*" });
  const lotTabs = funPayTabs.filter((candidate) => /\/lots\/\d+\/trade(?:[?#]|$)/.test(candidate.url || ""));
  const target = tab?.url?.startsWith("https://funpay.com/") && /\/lots\/\d+\/trade(?:[?#]|$)/.test(tab.url)
    ? tab
    : lotTabs[0];
  if (!target?.id) {
    const text = "Открой страницу своих лотов /lots/…/trade в FunPay. Цикл ничего не нажал.";
    await chrome.storage.local.set({ lastResult: text });
    return { ok: false, text };
  }
  try {
    let result;
    try {
      result = await chrome.tabs.sendMessage(target.id, { type: "MOONLIGHTFP_RUN_V9" });
    } catch {
      // A page that was already open when the extension was reloaded has no content script yet.
      await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
      result = await chrome.tabs.sendMessage(target.id, { type: "MOONLIGHTFP_RUN_V9" });
    }
    if (result?.text) await chrome.storage.local.set({ lastRun: Date.now(), lastResult: result.text });
    return result || { ok: false, text: "Не получил ответ от страницы. Обнови вкладку FunPay и повтори." };
  } catch (error) {
    const text = `Не удалось связаться со страницей FunPay: ${String(error?.message || error)}`;
    await chrome.storage.local.set({ lastResult: text });
    return { ok: false, text };
  }
}

async function loadStatsOnActiveFunPayTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const funPayTabs = await chrome.tabs.query({ url: "https://funpay.com/*" });
  const target = tab?.url?.startsWith("https://funpay.com/") ? tab : funPayTabs[0];
  if (!target?.id) {
    return { ok: false, text: "Открой FunPay в Brave и повтори." };
  }
  try {
    let data;
    try {
      data = await chrome.tabs.sendMessage(target.id, { type: "MOONLIGHTFP_COLLECT_STATS_V9" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
      data = await chrome.tabs.sendMessage(target.id, { type: "MOONLIGHTFP_COLLECT_STATS_V9" });
    }
    if (!data?.ok) return data || { ok: false, text: "Страница не вернула статистику." };
    return data;
  } catch (error) {
    return { ok: false, text: `Не удалось прочитать заказы: ${String(error?.message || error)}` };
  }
}
