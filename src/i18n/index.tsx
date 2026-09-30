import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { supportedLocales, translations, type AppLocale, type TranslationKey } from './translations';

const LANGUAGE_STORAGE_KEY = 'ielts_mockai_language';

type I18nContextValue = {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => Promise<void>;
  t: (key: TranslationKey) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

function getSystemLocale(): AppLocale {
  const languageCode = getLocales()[0]?.languageCode?.toLowerCase();
  return supportedLocales.includes(languageCode as AppLocale) ? (languageCode as AppLocale) : 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(() => getSystemLocale());
  const [hasManualPreference, setHasManualPreference] = useState(false);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((storedLocale) => {
        if (!active || !supportedLocales.includes(storedLocale as AppLocale)) {
          return;
        }
        setHasManualPreference(true);
        setLocaleState(storedLocale as AppLocale);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hasManualPreference) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setLocaleState(getSystemLocale());
      }
    });
    return () => subscription.remove();
  }, [hasManualPreference]);

  const setLocale = useCallback(async (nextLocale: AppLocale) => {
    setHasManualPreference(true);
    setLocaleState(nextLocale);
    try {
      await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
    } catch {
      // Keep the in-memory selection even when device storage is unavailable.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => translations[locale][key] ?? translations.en[key] ?? key,
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used inside I18nProvider');
  }
  return context;
}

export { localeNames, supportedLocales, type AppLocale, type TranslationKey } from './translations';
