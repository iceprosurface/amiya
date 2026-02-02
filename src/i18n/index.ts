import i18next, { type TOptions } from "i18next";

import { resources } from "./resources.js";

export type Locale = "en" | "zh";

const DEFAULT_LOCALE: Locale = "zh";

let initialized = false;
let currentLocale: Locale = DEFAULT_LOCALE;

const normalizeLocale = (value?: string): Locale => {
  if (!value) return DEFAULT_LOCALE;
  const normalized = value.trim().toLowerCase();
  if (normalized === "en" || normalized === "en-us" || normalized === "en_us") return "en";
  if (normalized === "zh" || normalized === "zh-cn" || normalized === "zh_cn" || normalized === "cn") {
    return "zh";
  }
  return DEFAULT_LOCALE;
};

export function initI18n(locale?: string): Locale {
  currentLocale = normalizeLocale(locale);
  if (!initialized) {
    i18next.init({
      resources,
      lng: currentLocale,
      fallbackLng: "en",
      initImmediate: false,
      interpolation: { escapeValue: false },
    });
    initialized = true;
  } else {
    i18next.changeLanguage(currentLocale);
  }
  return currentLocale;
}

export function getLocale(): Locale {
  if (!initialized) initI18n();
  return currentLocale;
}

export function t(key: string, options?: TOptions): string {
  if (!initialized) initI18n();
  return i18next.t(key, options);
}
