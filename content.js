(() => {
const CONTENT_VERSION = "0.9.0";
if (globalThis.__moonlightFPLoadedVersion === CONTENT_VERSION) return;
globalThis.__moonlightFPLoadedVersion = CONTENT_VERSION;

let running = false;
let surfaceScanTimer = 0;
let activeThemeEnabled = false;
const STYLE_ID = "moonlightfp-page-style";
const DASHBOARD_ID = "moonlightfp-dashboard";
let dashboardHost = null;
let savedPageContent = null;
let cachedStats = null;

applyAppearance();
initInSiteDashboard();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.theme || changes.font) applyAppearance();
  if (changes.enabled || changes.intervalMinutes || changes.lastRun || changes.lastResult) syncDashboardControls();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MOONLIGHTFP_RUN_V9") {
    runCycle().then(sendResponse);
    return true;
  }
  if (message?.type === "MOONLIGHTFP_COLLECT_STATS_V9") {
    collectStats().then(sendResponse);
    return true;
  }
});

async function runCycle() {
  if (running) return { ok: false, text: "Цикл поднятия уже выполняется." };
  running = true;
  try {
    if (!location.hostname.endsWith("funpay.com")) return;
    const candidates = [...document.querySelectorAll("button.js-lot-raise")]
      .filter(isVisible)
      .filter((button) => !button.disabled);
    if (!candidates.length) {
      const text = "На этой странице не нашёл доступных кнопок «Поднять предложения». Ничего не нажато.";
      report(text);
      return { ok: false, text };
    }
    let clicked = 0;
    for (const button of candidates) {
      if (!button.isConnected || button.disabled || !isVisible(button)) continue;
      const previousRequests = raiseRequestCount();
      const noticesBeforeClick = new Map(readNoticeElements().map(({ element, text }) => [element, text]));
      button.click();
      const requestSeen = await waitForRaiseRequest(previousRequests, 5000);
      if (!requestSeen) {
        const text = "Кнопка нажата, но новый запрос /lots/raise не появился. Остальные кнопки не нажимал.";
        report(text);
        return { ok: false, text };
      }
      clicked += 1;
      await delay(600);
      const cooldown = readCooldownNotice(noticesBeforeClick);
      if (cooldown) {
        const text = `FunPay получил запрос, но ответил ограничением: ${cooldown}`;
        report(text);
        return { ok: false, text };
      }
      // Give FunPay time to settle before another category group is raised.
      await delay(3500);
    }
    const text = clicked
      ? `Нажато кнопок «Поднять предложения»: ${clicked}. Проверь результат на странице FunPay.`
      : "Доступных кнопок для поднятия больше нет. Ничего не нажато.";
    report(text);
    return { ok: clicked > 0, text };
  } catch (error) {
    const text = `Цикл остановлен: ${String(error?.message || error)}`;
    report(text);
    return { ok: false, text };
  } finally {
    running = false;
  }
}

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function raiseRequestCount() {
  return performance.getEntriesByType("resource")
    .filter((entry) => /\/lots\/raise(?:\?|$)/.test(entry.name)).length;
}

async function waitForRaiseRequest(previousCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (raiseRequestCount() > previousCount) return true;
    await delay(200);
  }
  return false;
}

function readNoticeElements() {
  return [...document.querySelectorAll(".alert,[role=alert],.toast")]
    .filter(isVisible)
    .map((element) => ({ element, text: element.textContent.trim() }))
    .filter(({ text }) => Boolean(text));
}

function readCooldownNotice(previousNotices = new Map()) {
  return readNoticeElements().find(({ element, text }) => {
    const oldText = previousNotices.get(element);
    return (oldText === undefined || oldText !== text) && /подождите|wait/i.test(text);
  })?.text || "";
}

async function collectStats() {
  try {
    const PAGE_LIMIT = 100;
    const sales = await readOrderHistory("/orders/trade", PAGE_LIMIT);
    // FunPay serves the purchase history at /orders/; /orders/buy is not a
    // history endpoint and may return an unrelated page with HTTP 200.
    const purchases = await readOrderHistory("/orders/", PAGE_LIMIT);
    return { ok: true, data: { sales: sales.orders, purchases: purchases.orders, truncated: sales.truncated || purchases.truncated, pageLimit: PAGE_LIMIT } };
  } catch (error) {
    return { ok: false, text: `Не удалось собрать историю: ${String(error?.message || error)}` };
  }
}

async function readOrderHistory(path, pageLimit) {
  const orders = [];
  let cursor = "";
  let page = 0;
  const seen = new Set();
  const requestUrl = buildHistoryUrl(path);
  const expectedPath = requestUrl.pathname.replace(/\/+$/, "") || "/";
  while (page < pageLimit) {
    const options = { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } };
    if (cursor) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      options.body = new URLSearchParams({ continue: cursor });
    }
    const response = await fetch(requestUrl, options);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const responsePath = new URL(response.url || requestUrl.href).pathname.replace(/\/+$/, "") || "/";
    if (page === 0 && (/\/(?:login|auth)(?:\/|$)/i.test(responsePath) || doc.querySelector('input[type="password"], form[action*="login"]'))) {
      throw new Error("FunPay перенаправил на страницу входа. Проверь авторизацию в этой вкладке Brave.");
    }
    if (page === 0 && responsePath !== expectedPath) throw new Error(`FunPay перенаправил запрос истории на ${responsePath}. Ожидался ${expectedPath}.`);
    const cards = [...doc.querySelectorAll("a.tc-item")];
    for (const card of cards) {
      const order = parseOrderCard(card);
      if (order && !seen.has(order.id)) { seen.add(order.id); orders.push(order); }
    }
    const next = doc.querySelector('input[name="continue"]')?.value || "";
    if (!next || next === cursor || !cards.length) return { orders, truncated: false };
    cursor = next;
    page += 1;
    await delay(350);
  }
  return { orders, truncated: true };
}

function buildHistoryUrl(path) {
  // FunPay prefixes localized pages (for example /en/); use the same locale
  // for history endpoints instead of silently falling back to the default UI.
  const localePrefix = location.pathname.match(/^\/(en|uk|ru)(?=\/|$)/i)?.[0] || "";
  return new URL(`${localePrefix}${path}`, location.origin);
}

function parseOrderCard(card) {
  const id = card.querySelector(".tc-order")?.textContent.trim().replace(/^#/, "");
  const priceText = card.querySelector(".tc-price")?.textContent.trim().replace(/\u00a0/g, " ");
  if (!id || !priceText) return null;
  const match = priceText.match(/([+−–—-]?\s*[\d\s\u00a0]+(?:[,.]\d+)?)\s*(₽|руб\.?|\$|USD|€|EUR|UAH|₴)/i);
  if (!match) return null;
  const amount = Number(`${/[-−–—]/.test(match[1]) ? "-" : ""}${match[1].replace(/[+−–—-]/g, "").replace(/[\s\u00a0]/g, "").replace(",", ".")}`);
  if (!Number.isFinite(amount)) return null;
  const currency = /₽|руб/i.test(match[2]) ? "RUB" : /\$|USD/i.test(match[2]) ? "USD" : /€|EUR/i.test(match[2]) ? "EUR" : "UAH";
  const dateEl = card.querySelector(".tc-date-time");
  const rawTimestamp = dateEl?.getAttribute("data-timestamp") || dateEl?.querySelector("[data-timestamp]")?.getAttribute("data-timestamp");
  const timestamp = rawTimestamp ? normalizeTimestamp(rawTimestamp) : parseOrderDate(dateEl?.textContent || "");
  const statusNodes = [card, card.querySelector(".tc-status")].filter(Boolean);
  const hasClass = (name) => statusNodes.some((node) => node.classList.contains(name));
  const status = hasClass("warning") ? "refunded" : hasClass("info") ? "paid" : "closed";
  return { id, amount, currency, timestamp, status };
}

function normalizeTimestamp(value) {
  const num = Number(value);
  return Number.isFinite(num) ? (num < 1e12 ? num * 1000 : num) : Date.parse(value) || 0;
}

function parseOrderDate(text) {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();
  const now = new Date();
  let date;
  if (/сегодня|\btoday\b/.test(value)) date = new Date(now);
  else if (/вчера|\byesterday\b/.test(value)) { date = new Date(now); date.setDate(date.getDate() - 1); }
  else {
    const months = { января:0, февраля:1, марта:2, апреля:3, мая:4, июня:5, июля:6, августа:7, сентября:8, октября:9, ноября:10, декабря:11 };
    const numeric = value.match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:,?\s+(\d{1,2}):(\d{2}))?/);
    if (numeric) {
      const month = Number(numeric[2]) - 1;
      let year = Number(numeric[3]) || now.getFullYear();
      if (!numeric[3] && month > now.getMonth()) year -= 1;
      return new Date(year, month, Number(numeric[1]), Number(numeric[4] || 0), Number(numeric[5] || 0)).getTime();
    }
    const localizedMonth = value.match(/(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?/i);
    if (localizedMonth && months[localizedMonth[2]] !== undefined) {
      let year = Number(localizedMonth[3]) || now.getFullYear();
      if (!localizedMonth[3] && months[localizedMonth[2]] > now.getMonth()) year -= 1;
      date = new Date(year, months[localizedMonth[2]], Number(localizedMonth[1]), Number(localizedMonth[4] || 0), Number(localizedMonth[5] || 0));
    } else {
      const englishMonths = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11, jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };
      const englishMonth = value.match(/(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?(?:,?\s+(\d{1,2}):(\d{2}))?/i);
      if (!englishMonth || englishMonths[englishMonth[2]] === undefined) return 0;
      const month = englishMonths[englishMonth[2]];
      let year = Number(englishMonth[3]) || now.getFullYear();
      if (!englishMonth[3] && month > now.getMonth()) year -= 1;
      date = new Date(year, month, Number(englishMonth[1]), Number(englishMonth[4] || 0), Number(englishMonth[5] || 0));
    }
  }
  const clock = value.match(/(\d{1,2}):(\d{2})/);
  if (clock && (/сегодня|вчера|\btoday\b|\byesterday\b/.test(value))) date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
  return date.getTime();
}

function report(text) {
  chrome.runtime.sendMessage({ type: "MOONLIGHTFP_RESULT", text });
}

async function applyAppearance() {
  const { theme = "default", font = "copperplate" } = await chrome.storage.local.get(["theme", "font"]);
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).append(style);
  }
  const themes = {
    default: "",
    moonlight: "--ml-bg:#15131f;--ml-panel:#211d2d;--ml-border:#393149;--ml-text:#eee9f7;--ml-accent:#b59aff;--ml-link:#cdbaff;",
    firewatch: "--ml-bg:#201714;--ml-panel:#30201a;--ml-border:#56362a;--ml-text:#f6e9dc;--ml-accent:#ff985d;--ml-link:#ffb178;",
    redmoon: "--ml-bg:#1c1118;--ml-panel:#291722;--ml-border:#4b2536;--ml-text:#f4e8ee;--ml-accent:#ec6794;--ml-link:#f38ab0;",
    ocean: "--ml-bg:#101a20;--ml-panel:#18262e;--ml-border:#2b4652;--ml-text:#e4f2f5;--ml-accent:#69c8d4;--ml-link:#8ce0e8;"
  };
  const fonts = {
    copperplate: '"Moonlight Copperplate", "Copperplate Gothic", "Copperplate Gothic Light", "Bookman Old Style", "Georgia", serif',
    cinzel: '"Cinzel", "Georgia", "Times New Roman", serif',
    georgia: '"Georgia", "Times New Roman", serif',
    gabriola: '"Gabriola", "Georgia", serif'
  };
  const vars = themes[theme] || themes.default;
  activeThemeEnabled = Boolean(vars);
  const fontFamily = fonts[font] || fonts.copperplate;
  style.textContent = `
    @font-face { font-family:"Moonlight Copperplate"; src:local("Copperplate Gothic Light"),local("Copperplate Gothic"); font-style:normal; font-weight:400; }
    @font-face { font-family:"Moonlight Copperplate"; src:local("Copperplate Gothic Bold"),local("Copperplate Gothic"); font-style:normal; font-weight:700; }
    :root { ${vars} }
    ${vars ? `
      html, body { background-color:var(--ml-bg)!important; color:var(--ml-text)!important; }
      .container, .container-fluid, .content, .content-with-categories, .page-content { background-color:transparent!important; }
      [data-moonlightfp-surface="1"] { background-color:var(--ml-panel)!important; color:var(--ml-text)!important; border-color:var(--ml-border)!important; }
      .navbar, .navbar-default, .navbar-inverse, .panel-default, .well, .dropdown-menu, .list-group-item, .modal-content {
        background-color:var(--ml-panel)!important; color:var(--ml-text); border-color:var(--ml-border)!important;
      }
      .chat, .chat-list, .chat-list-container, .chat-sidebar, .chat-info, .chat-profile, .chat-header,
      .chat-form, .chat-messages, .chat-empty, .contact-item, .chat-msg-item, .chat-message,
      .chat .media, .chat .media-body, .chat .col-xs-3, .chat .col-sm-3, .chat .col-md-3, .chat .col-lg-3,
      .chat .col-xs-9, .chat .col-sm-9, .chat .col-md-9, .chat .col-lg-9,
      .media, .param-item, .profile-info, .profile-sidebar {
        background-color:var(--ml-panel)!important; color:var(--ml-text)!important; border-color:var(--ml-border)!important;
      }
      .form-control, input, textarea, select { background-color:var(--ml-bg)!important; color:var(--ml-text)!important; border-color:var(--ml-border)!important; }
      .text-muted, .help-block, .chat-empty { color:color-mix(in srgb, var(--ml-text) 68%, transparent)!important; }
      a:not(.btn) { color:var(--ml-link); }
      .btn-primary { background-color:var(--ml-accent)!important; border-color:var(--ml-accent)!important; color:#17131f!important; }
      .table > tbody > tr:not(.warning):not(.success):not(.danger):not(.info) > td,
      .table > tbody > tr:not(.warning):not(.success):not(.danger):not(.info) > th { background-color:var(--ml-panel); border-color:var(--ml-border); }
      .table > tbody > tr:not(.warning):not(.success):not(.danger):not(.info) { color:var(--ml-text); }
      .table > tbody > tr.warning > td, .table > tbody > tr.warning > th { color:#4f430b; }
      .table > tbody > tr.success > td, .table > tbody > tr.success > th { color:#174b2a; }
      .table > tbody > tr.danger > td, .table > tbody > tr.danger > th { color:#641f24; }
    ` : ""}
    body, body :not(i):not(svg):not(path):not(.fa):not([class*="fa-"]):not([class*="glyphicon"]):not([class*="icon-"]) {
      font-family:${fontFamily}!important;
    }
    .user-link, a.user-link, .user-link-name, .media-user-name, .chat-header__name, .offer-user-link, .user-profile-link, .navbar .user-link,
    .media-body a, .chat-list a[href*="/users/"], h1[data-moonlight-profile-name] {
      font-family:${fontFamily}!important; font-weight:400!important; letter-spacing:.035em;
    }
  `;
  markLightPanels(Boolean(vars));
  if (!globalThis.__moonlightFPSurfaceObserver && document.documentElement) {
    globalThis.__moonlightFPSurfaceObserver = new MutationObserver(() => {
      clearTimeout(surfaceScanTimer);
      surfaceScanTimer = setTimeout(() => {
        markLightPanels(activeThemeEnabled);
        ensureDashboardNav();
      }, 180);
    });
    globalThis.__moonlightFPSurfaceObserver.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"]
    });
  }

  // FunPay renders the account name as a page heading rather than a user-link.
  if (location.pathname.startsWith("/users/")) {
    const profileHeading = [...document.querySelectorAll("h1, h2")]
      .find((heading) => /^[\p{L}\p{N}_ .-]{2,40}$/u.test(heading.textContent.trim()));
    if (profileHeading) profileHeading.setAttribute("data-moonlight-profile-name", "true");
  }
}

function markLightPanels(enabled) {
  for (const el of document.querySelectorAll("[data-moonlightfp-surface]")) {
    el.removeAttribute("data-moonlightfp-surface");
  }
  if (!enabled) return;
  const structuralTags = "div,main,aside,section,article,header,footer";
  for (const el of document.querySelectorAll(structuralTags)) {
    const rect = el.getBoundingClientRect();
    // Homepage's Your games band is shorter than the product pages' panels.
    if (rect.width < 240 || rect.height < 80 || rect.width * rect.height < 30000) continue;
    const color = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/i);
    if (!color) continue;
    const channels = color[1].split(",").map((value) => Number.parseFloat(value.trim()));
    const opacity = channels.length > 3 ? channels[3] : 1;
    if (opacity >= 0.9 && channels.slice(0, 3).every((channel) => channel >= 238)) {
      el.setAttribute("data-moonlightfp-surface", "1");
    }
  }
}

function initInSiteDashboard() {
  ensureDashboardNav();
  window.addEventListener("hashchange", handleDashboardRoute);
  window.addEventListener("popstate", handleDashboardRoute);
  if (location.hash === "#moonlightfp") openDashboard();
}

function ensureDashboardNav() {
  if (document.querySelector(".moonlightfp-nav-item")) return;
  const navLinks = [...document.querySelectorAll(".navbar a, .navbar-nav a, nav a")];
  const salesLink = (navLinks.length ? navLinks : [...document.querySelectorAll("a")]).find((link) => {
    try { return /\/orders\/trade\/?$/.test(new URL(link.href, location.origin).pathname); }
    catch { return false; }
  });
  const fallbackLinks = navLinks.length ? navLinks : [...document.querySelectorAll("a")];
  const anchorLink = salesLink || fallbackLinks.find((link) => {
    try { return /\/chat\/?$/.test(new URL(link.href, location.origin).pathname); }
    catch { return false; }
  });
  const list = anchorLink?.closest("li")?.parentElement;
  if (!list || !anchorLink) return;
  const item = document.createElement("li");
  item.className = "moonlightfp-nav-item";
  const link = document.createElement("a");
  link.href = "#moonlightfp";
  link.textContent = "MoonlightFP";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    if (location.hash !== "#moonlightfp") history.pushState({ moonlightfp: true }, "", `${location.pathname}${location.search}#moonlightfp`);
    openDashboard();
  });
  item.append(link);
  if (salesLink?.closest("li")) salesLink.closest("li").insertAdjacentElement("afterend", item);
  else list.append(item);
}

function handleDashboardRoute() {
  if (location.hash === "#moonlightfp") openDashboard();
  else closeDashboard();
}

function findMainPageRoot() {
  const nav = document.querySelector(".navbar, nav");
  const navBottom = nav?.getBoundingClientRect().bottom ?? 0;
  const selectors = ["#content", "main", ".page-content", ".content-with-categories", ".container"];
  const candidates = selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter((el) => !el.contains(nav) && !el.closest(".navbar") && !el.closest("nav") && el.getBoundingClientRect().width >= 650 && el.getBoundingClientRect().top >= navBottom - 4);
  const preferred = candidates.find((el) => el.matches("#content, main, .page-content, .content-with-categories"));
  if (preferred) return preferred;
  return candidates.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0] || document.body;
}

function openDashboard() {
  if (document.getElementById(DASHBOARD_ID)) return;
  const root = findMainPageRoot();
  if (root === document.body) {
    dashboardHost = root;
    savedPageContent = document.createDocumentFragment();
    for (const node of [...root.childNodes]) {
      if (node.nodeType === Node.ELEMENT_NODE && (node.matches(".navbar, nav") || node.contains(document.querySelector(".navbar, nav")))) continue;
      savedPageContent.append(node);
    }
  } else {
    dashboardHost = root;
    savedPageContent = document.createDocumentFragment();
    while (root.firstChild) savedPageContent.append(root.firstChild);
  }
  dashboardHost.append(createDashboard());
  dashboardHost.classList.add("moonlightfp-host");
  document.querySelector(".moonlightfp-nav-item")?.classList.add("active");
  syncDashboardControls();
}

function closeDashboard() {
  const dashboard = document.getElementById(DASHBOARD_ID);
  if (!dashboard || !dashboardHost || !savedPageContent) return;
  dashboard.remove();
  dashboardHost.append(savedPageContent);
  dashboardHost.classList.remove("moonlightfp-host");
  savedPageContent = null;
  dashboardHost = null;
  document.querySelector(".moonlightfp-nav-item")?.classList.remove("active");
}

function createDashboard() {
  const section = document.createElement("section");
  section.id = DASHBOARD_ID;
  section.innerHTML = `
    <div class="mlfp-heading"><div><h1>MoonlightFP</h1><p>Настройки FunPay и статистика в одном месте</p></div><button type="button" class="mlfp-secondary" data-action="close">Вернуться на FunPay</button></div>
    <div class="mlfp-grid">
      <section class="mlfp-card">
        <h2>Автоподнятие</h2>
        <label class="mlfp-toggle"><input type="checkbox" data-setting="enabled"><span>Включить по расписанию</span></label>
        <label class="mlfp-label">Интервал, минут (минимум 240)<input type="number" min="240" step="60" data-setting="intervalMinutes"></label>
        <p class="mlfp-note">Работает, пока открыта вкладка FunPay с твоими лотами. Поднимаются группы, для которых FunPay показывает кнопку «Поднять предложения».</p>
        <button type="button" data-action="raise">Поднять предложения сейчас</button>
        <div class="mlfp-status" data-role="status">Загружаю настройки…</div>
      </section>
      <section class="mlfp-card">
        <h2>Оформление FunPay</h2>
        <label class="mlfp-label">Тема<select data-setting="theme"><option value="default">Как на FunPay</option><option value="moonlight">Moonlight</option><option value="firewatch">Firewatch</option><option value="redmoon">Red Moon</option><option value="ocean">Ocean</option></select></label>
        <label class="mlfp-label">Шрифт текста<select data-setting="font"><option value="copperplate">Copperplate Gothic / похожий</option><option value="cinzel">Cinzel / классический</option><option value="georgia">Georgia</option><option value="gabriola">Gabriola / каллиграфический</option></select></label>
        <p class="mlfp-note">Copperplate Gothic применяется к латинице; для кириллицы используется похожий запасной шрифт.</p>
      </section>
      <section class="mlfp-card mlfp-statistics">
        <h2>Продажи и покупки</h2>
        <div class="mlfp-stats-controls"><label class="mlfp-label">Период<select data-setting="statsPeriod"><option value="all">Всё время</option><option value="30">30 дней</option><option value="7">7 дней</option><option value="1">Сегодня</option></select></label><button type="button" data-action="stats">Собрать статистику</button></div>
        <div class="mlfp-stats" data-role="stats">Статистика пока не загружена.</div>
      </section>
    </div>`;
  section.addEventListener("change", (event) => {
    const setting = event.target.dataset.setting;
    if (setting === "enabled") chrome.storage.local.set({ enabled: event.target.checked });
    if (setting === "intervalMinutes") {
      const value = Math.max(240, Number(event.target.value) || 240);
      event.target.value = value;
      chrome.storage.local.set({ intervalMinutes: value });
    }
    if (setting === "theme" || setting === "font") chrome.storage.local.set({ [setting]: event.target.value });
    if (setting === "statsPeriod" && cachedStats) section.querySelector('[data-role="stats"]').textContent = formatStats(cachedStats, event.target.value);
  });
  section.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "close") {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      closeDashboard();
    }
    if (action === "raise") {
      const button = event.target.closest("button");
      const status = section.querySelector('[data-role="status"]');
      button.disabled = true;
      status.textContent = "Отправляю команду на страницу твоих лотов…";
      try {
        const result = await chrome.runtime.sendMessage({ type: "MOONLIGHTFP_RUN_NOW" });
        status.textContent = result?.text || "Расширение не вернуло результат.";
      } catch (error) { status.textContent = `Ошибка: ${String(error?.message || error)}`; }
      finally { button.disabled = false; }
    }
    if (action === "stats") {
      const button = event.target.closest("button");
      const output = section.querySelector('[data-role="stats"]');
      button.disabled = true;
      button.textContent = "Загружаю историю…";
      output.textContent = "Читаю продажи и покупки через эту сессию FunPay…";
      try {
        const result = await collectStats();
        if (!result.ok) throw new Error(result.text);
        cachedStats = result.data;
        output.textContent = formatStats(cachedStats, section.querySelector('[data-setting="statsPeriod"]').value);
      } catch (error) { output.textContent = String(error?.message || error); }
      finally { button.disabled = false; button.textContent = "Собрать статистику"; }
    }
  });
  return section;
}

async function syncDashboardControls() {
  const section = document.getElementById(DASHBOARD_ID);
  if (!section) return;
  const settings = await chrome.storage.local.get(["enabled", "intervalMinutes", "theme", "font", "lastRun", "lastResult"]);
  const enabled = section.querySelector('[data-setting="enabled"]');
  if (enabled) enabled.checked = Boolean(settings.enabled);
  const interval = section.querySelector('[data-setting="intervalMinutes"]');
  if (interval) interval.value = Math.max(240, Number(settings.intervalMinutes) || 240);
  for (const name of ["theme", "font"]) {
    const field = section.querySelector(`[data-setting="${name}"]`);
    if (field) field.value = settings[name] || (name === "theme" ? "default" : "copperplate");
  }
  const status = section.querySelector('[data-role="status"]');
  if (status) status.textContent = [settings.enabled ? "Автоподнятие включено" : "Автоподнятие выключено", settings.lastRun ? `Последний запуск: ${new Date(settings.lastRun).toLocaleString("ru-RU")}` : "Запусков ещё не было", settings.lastResult].filter(Boolean).join(" · ");
}

function formatStats(data, period) {
  let start = -Infinity;
  if (period !== "all") {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - (Number(period) - 1));
    start = dayStart.getTime();
  }
  const output = [];
  for (const [key, label] of [["sales", "Продажи"], ["purchases", "Покупки"]]) {
    const orders = (data?.[key] || []).filter((order) => period === "all" || (order.timestamp && order.timestamp >= start));
    const currencies = new Map();
    for (const order of orders) {
      const current = currencies.get(order.currency) || { count: 0, amount: 0, closed: 0, paid: 0, refunded: 0 };
      current.count += 1;
      current.amount += order.amount;
      current[order.status] = (current[order.status] || 0) + order.amount;
      currencies.set(order.currency, current);
    }
    const sums = [...currencies].map(([currency, value]) => `${currency}: ${value.count} заказов · ${value.amount.toFixed(2)} всего · завершено ${value.closed.toFixed(2)} · оплачено ${value.paid.toFixed(2)} · возвраты ${value.refunded.toFixed(2)}`).join("\n") || "нет данных";
    output.push(`${label}: ${orders.length}\n${sums}`);
  }
  if (data?.truncated) output.push(`Достигнут предел загрузки: максимум ${data.pageLimit} страниц на тип заказов.`);
  return output.join("\n\n");
}

const dashboardStyle = document.createElement("style");
dashboardStyle.id = "moonlightfp-dashboard-style";
dashboardStyle.textContent = `
  #moonlightfp-dashboard { max-width:1140px; margin:22px auto; padding:24px; color:var(--ml-text,#eee9f7); background:var(--ml-bg,#15131f); border-radius:12px; }
  #moonlightfp-dashboard * { box-sizing:border-box; }
  #moonlightfp-dashboard .mlfp-heading { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:22px; }
  #moonlightfp-dashboard h1 { margin:0 0 5px; color:inherit; }
  #moonlightfp-dashboard h2 { margin:0 0 16px; font-size:19px; color:inherit; }
  #moonlightfp-dashboard p { color:inherit; }
  #moonlightfp-dashboard .mlfp-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
  #moonlightfp-dashboard .mlfp-card { min-width:0; padding:20px; background:var(--ml-panel,#211d2d); border:1px solid var(--ml-border,#393149); border-radius:12px; }
  #moonlightfp-dashboard .mlfp-statistics { grid-column:1/-1; }
  #moonlightfp-dashboard .mlfp-label { display:flex; flex-direction:column; gap:7px; margin:12px 0; color:inherit; }
  #moonlightfp-dashboard .mlfp-label input,#moonlightfp-dashboard .mlfp-label select { width:100%; padding:10px 12px; color:inherit; background:var(--ml-bg,#15131f); border:1px solid var(--ml-border,#393149); border-radius:8px; }
  #moonlightfp-dashboard button { padding:11px 16px; color:#17131f; background:var(--ml-accent,#b59aff); border:1px solid var(--ml-accent,#b59aff); border-radius:8px; font-weight:650; cursor:pointer; }
  #moonlightfp-dashboard button:disabled { opacity:.6; cursor:wait; }
  #moonlightfp-dashboard button.mlfp-secondary { color:var(--ml-text,#eee9f7); background:transparent; border-color:var(--ml-border,#393149); }
  #moonlightfp-dashboard .mlfp-toggle { display:flex; align-items:center; gap:10px; }
  #moonlightfp-dashboard .mlfp-toggle input { width:18px; height:18px; accent-color:var(--ml-accent,#b59aff); }
  #moonlightfp-dashboard .mlfp-note { padding:12px; border-radius:8px; background:rgba(128,110,170,.15); font-size:13px; }
  #moonlightfp-dashboard .mlfp-status,#moonlightfp-dashboard .mlfp-stats { margin-top:12px; padding:12px; white-space:pre-line; overflow-wrap:anywhere; background:rgba(0,0,0,.24); border-radius:8px; }
  #moonlightfp-dashboard .mlfp-stats-controls { display:grid; grid-template-columns:minmax(180px,260px) auto; align-items:end; gap:14px; }
  @media(max-width:760px) { #moonlightfp-dashboard { margin:12px auto; padding:14px; } #moonlightfp-dashboard .mlfp-grid { grid-template-columns:1fr; } #moonlightfp-dashboard .mlfp-statistics { grid-column:auto; } #moonlightfp-dashboard .mlfp-heading { align-items:flex-start; flex-direction:column; } }
`;
document.documentElement.append(dashboardStyle);
})();
