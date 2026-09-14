import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";
const themeEvent = "crew-theme-change";
const currentTheme = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7f2" : "#0c111b");
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key !== "crew.theme" && event.key !== null) return;
    applyTheme(event.newValue === "light" ? "light" : "dark");
    listener();
  };
  window.addEventListener(themeEvent, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(themeEvent, listener);
    window.removeEventListener("storage", storage);
  };
}
function selectTheme(theme: Theme) {
  applyTheme(theme);
  try { localStorage.setItem("crew.theme", theme); } catch { /* Keep the current view usable. */ }
  window.dispatchEvent(new Event(themeEvent));
}
export function ThemePicker() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "dark" as const);
  return <div className="theme-picker" role="group" aria-label="화면 테마">
    <button type="button" aria-label="라이트 테마" aria-pressed={theme === "light"} title="라이트 테마" onClick={() => selectTheme("light")}>
      <Sun size={15} /><span>라이트</span>
    </button>
    <button type="button" aria-label="다크 테마" aria-pressed={theme === "dark"} title="다크 테마" onClick={() => selectTheme("dark")}>
      <Moon size={15} /><span>다크</span>
    </button>
  </div>;
}
