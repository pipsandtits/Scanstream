import React, { createContext, useContext, useEffect, useState, ReactNode, useRef } from 'react';

type ThemePreset = 'dark' | 'light' | 'oled' | 'cyberpunk' | 'forest' | 'ocean' | 'sunset';

interface PreferencesState {
  preset: ThemePreset;
  fontSize: 'small' | 'medium' | 'large';
  opacity: number;
  highContrast: boolean;
  pinnedSymbols: string[];
  workspace: string;
}

interface PreferencesContextType extends PreferencesState {
  setPreset: (p: ThemePreset) => void;
  setFontSize: (s: 'small' | 'medium' | 'large') => void;
  setOpacity: (v: number) => void;
  setHighContrast: (b: boolean) => void;
  setPinnedSymbols: (vals: string[]) => void;
  setWorkspace: (ws: string) => void;
}

const PreferencesContext = createContext<PreferencesContextType | undefined>(undefined);

function safeGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (e) {
    return fallback;
  }
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preset, setPresetState] = useState<ThemePreset>(() => safeGet('theme-preset', ('dark' as ThemePreset)));
  const [fontSize, setFontSizeState] = useState<'small' | 'medium' | 'large'>(() => safeGet('font-size', 'medium'));
  const [opacity, setOpacityState] = useState<number>(() => safeGet('opacity', 0.95));
  const [highContrast, setHighContrastState] = useState<boolean>(() => safeGet('high-contrast', false));
  const [pinnedSymbols, setPinnedSymbolsState] = useState<string[]>(() => safeGet('pinned-symbols', []));
  const [workspace, setWorkspaceState] = useState<string>(() => safeGet('workspace', 'Default'));

  // Debounced persistence to localStorage
  const persistTimer = useRef<number | null>(null);

  useEffect(() => {
    if (persistTimer.current) window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem('theme-preset', JSON.stringify(preset));
        localStorage.setItem('font-size', JSON.stringify(fontSize));
        localStorage.setItem('opacity', JSON.stringify(opacity));
        localStorage.setItem('high-contrast', JSON.stringify(highContrast));
        localStorage.setItem('pinned-symbols', JSON.stringify(pinnedSymbols));
        localStorage.setItem('workspace', JSON.stringify(workspace));
      } catch (e) {
        // ignore storage errors
      }
      persistTimer.current = null;
    }, 250);
    return () => {
      if (persistTimer.current) window.clearTimeout(persistTimer.current);
    };
  }, [preset, fontSize, opacity, highContrast, pinnedSymbols, workspace]);

  const setPreset = (p: ThemePreset) => setPresetState(p);
  const setFontSize = (s: 'small' | 'medium' | 'large') => setFontSizeState(s);
  const setOpacity = (v: number) => setOpacityState(v);
  const setHighContrast = (b: boolean) => setHighContrastState(b);
  const setPinnedSymbols = (vals: string[]) => setPinnedSymbolsState(vals);
  const setWorkspace = (ws: string) => setWorkspaceState(ws);

  return (
    <PreferencesContext.Provider
      value={{ preset, fontSize, opacity, highContrast, pinnedSymbols, workspace, setPreset, setFontSize, setOpacity, setHighContrast, setPinnedSymbols, setWorkspace }}
    >
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences() {
  const ctx = useContext(PreferencesContext);
  if (!ctx) throw new Error('usePreferences must be used within PreferencesProvider');
  return ctx;
}
