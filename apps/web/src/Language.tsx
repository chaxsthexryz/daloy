import { createContext, useContext } from "react";
import { translate, type Language } from "./lib/locale";

export const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void }>({ language: "en", setLanguage: () => undefined });
export function useLanguage() {
  const value = useContext(LanguageContext);
  return { ...value, t: (source: string, values?: Record<string, string | number>) => translate(value.language, source, values) };
}

/** Only use for literal interface copy, never user-authored values. */
export function Text({ children }: { children: string }) {
  const { t } = useLanguage();
  return t(children);
}
