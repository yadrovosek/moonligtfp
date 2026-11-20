document.querySelector("#open-dashboard").addEventListener("click", async () => {
  const button = document.querySelector("#open-dashboard");
  button.disabled = true;
  button.textContent = "Открываю FunPay…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id && tab.url?.startsWith("https://funpay.com/")) {
      const url = new URL(tab.url);
      url.hash = "moonlightfp";
      await chrome.tabs.update(tab.id, { url: url.href });
    } else {
      await chrome.tabs.create({ url: "https://funpay.com/#moonlightfp" });
    }
    window.close();
  } catch (error) {
    button.disabled = false;
    button.textContent = `Не удалось открыть: ${String(error?.message || error)}`;
  }
});
