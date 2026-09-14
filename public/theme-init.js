// Apply the saved theme before the application paints; no inline script needed.
(() => {
  let theme = "dark";
  try {
    const saved = localStorage.getItem("crew.theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch { /* Theme switching also works when storage is unavailable. */ }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#f4f7f2" : "#0c111b");
})();
