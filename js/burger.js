export function initBurger() {
  const btn = document.getElementById("burger-btn");
  const menu = document.getElementById("topbar-menu");
  if (!btn || !menu) return;
  btn.addEventListener("click", () => menu.classList.toggle("open"));
  menu.querySelectorAll("a").forEach(a => a.addEventListener("click", () => menu.classList.remove("open")));
}
