import { useEffect, type ReactNode } from 'react';
import { APP_EVENTS, STORAGE_KEYS } from '@/shared/constants';

export type ThemeMode = 'system' | 'light' | 'dark';

export const getThemeMode = (): ThemeMode => {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME);
  return savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : 'system';
};

export const setThemeMode = (mode: ThemeMode) => {
  if (mode === 'system') localStorage.removeItem(STORAGE_KEYS.THEME);
  else localStorage.setItem(STORAGE_KEYS.THEME, mode);
  window.dispatchEvent(new Event(APP_EVENTS.THEME_UPDATED));
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const applyTheme = () => {
      const savedTheme = getThemeMode();
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const isDark = savedTheme === 'dark' || (savedTheme === 'system' && systemDark);
      document.documentElement.classList.toggle('dark', isDark);

      const themeColor = getComputedStyle(document.documentElement)
        .getPropertyValue('--browser-theme-color')
        .trim();
      if (themeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
    };

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.THEME || event.key === null) applyTheme();
    };
    applyTheme();
    mediaQuery.addEventListener('change', applyTheme);
    window.addEventListener(APP_EVENTS.THEME_UPDATED, applyTheme);
    window.addEventListener('storage', handleStorage);
    return () => {
      mediaQuery.removeEventListener('change', applyTheme);
      window.removeEventListener(APP_EVENTS.THEME_UPDATED, applyTheme);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  return <>{children}</>;
}
