const CURRENCY_BY_REGION = {
  RU: { code: "RUB", locale: "ru-RU" },
  KZ: { code: "KZT", locale: "kk-KZ" },
  BY: { code: "BYN", locale: "be-BY" },
  UA: { code: "UAH", locale: "uk-UA" },
  US: { code: "USD", locale: "en-US" }
};

const LANG_TO_REGION = { ru: "RU", kk: "KZ", uk: "UA", be: "BY" };

function detectRegion() {
  const lang = navigator.language || "en-US";
  const parts = lang.split("-");
  if (parts[1]) return parts[1].toUpperCase();
  return LANG_TO_REGION[parts[0].toLowerCase()] || "US";
}

export const currentCurrency = { code: "USD", locale: "en-US", rate: 1, ready: false };

// 1. курс кэшируется в localStorage на сутки — не дёргаем API на каждую загрузку страницы
export async function initCurrency() {
  const region = detectRegion();
  const target = CURRENCY_BY_REGION[region] || CURRENCY_BY_REGION.US;
  currentCurrency.code = target.code;
  currentCurrency.locale = target.locale;

  if (target.code === "USD") {
    currentCurrency.rate = 1;
    currentCurrency.ready = true;
    return currentCurrency;
  }

  try {
    const cacheKey = "forge_fx_" + target.code;
    const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
    const dayMs = 24 * 60 * 60 * 1000;
    if (cached && Date.now() - cached.ts < dayMs) {
      currentCurrency.rate = cached.rate;
    } else {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      const data = await res.json();
      const rate = data?.rates?.[target.code];
      if (rate) {
        currentCurrency.rate = rate;
        localStorage.setItem(cacheKey, JSON.stringify({ rate, ts: Date.now() }));
      }
    }
  } catch (e) {
    console.warn("Не удалось получить курс валют, показываю в USD:", e);
    currentCurrency.code = "USD";
    currentCurrency.locale = "en-US";
    currentCurrency.rate = 1;
  }
  currentCurrency.ready = true;
  return currentCurrency;
}

export function formatPrice(usd) {
  const value = Number(usd) * currentCurrency.rate;
  try {
    return new Intl.NumberFormat(currentCurrency.locale, {
      style: "currency",
      currency: currentCurrency.code,
      maximumFractionDigits: currentCurrency.code === "USD" ? 2 : 0
    }).format(value);
  } catch {
    return "$" + Number(usd).toFixed(2);
  }
}
