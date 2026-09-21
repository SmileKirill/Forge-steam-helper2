import { db, auth } from "./firebase-config.js";
import { watchAuthUI } from "./auth.js";
import { initBurger } from "./burger.js";
import { initCurrency } from "./currency.js";
import { cardTemplate, priceLabel } from "./game-card.js";
import { getWishlist, attachWishlistHandlers } from "./wishlist.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, query, where, orderBy, limit, startAfter, getDocs, getCountFromServer, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const PAGE_SIZE = 12;
const TOP_CATEGORIES_COUNT = 4;

const popularRow = document.getElementById("popular-row");
const dealsRow = document.getElementById("deals-row");
const categoryTiles = document.getElementById("category-tiles");
const hero = document.getElementById("hero");
const grid = document.getElementById("games-grid");
const genreWrap = document.getElementById("filter-genres");
const sortSelect = document.getElementById("sort-select");
const searchInput = document.getElementById("search-input");
const paginationEl = document.getElementById("pagination");

let catalogState = { genre: "all", sort: "relevance", page: 1, cursors: [], totalPages: 1 };
let allGenres = [];
let ownedSlugs = new Set();
let wishlistSlugs = new Set();
const wishlistRef = { get current() { return wishlistSlugs; } };

function render(g) {
  return cardTemplate(g, { owned: ownedSlugs.has(g.id), wishlisted: wishlistSlugs.has(g.id) });
}

function docsToGames(snapshot) {
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

function wrapSlider(container, rowInnerHTML) {
  container.innerHTML = `
    <button class="slider-arrow left" aria-label="Назад">‹</button>
    <div class="row-scroll">${rowInnerHTML}</div>
    <button class="slider-arrow right" aria-label="Вперёд">›</button>`;
  const track = container.querySelector(".row-scroll");
  container.querySelector(".left").addEventListener("click", () => track.scrollBy({ left: -600, behavior: "smooth" }));
  container.querySelector(".right").addEventListener("click", () => track.scrollBy({ left: 600, behavior: "smooth" }));
}

async function loadHeroAndPopular() {
  const snap = await getDocs(query(collection(db, "games"), orderBy("ratingsCount", "desc"), limit(10)));
  const games = docsToGames(snap);
  wrapSlider(popularRow, games.map(render).join(""));

  const g = games[0];
  if (!g) { hero.innerHTML = ""; return; }
  const platformsCount = (g.platforms || []).length;
  hero.innerHTML = `
    <div class="hero-inner">
      <div class="hero-text">
        <span class="hero-kicker">Популярное сейчас</span>
        <h2 class="hero-title">${g.title}</h2>
        <p class="hero-desc">${g.shortDescription}</p>
        <div class="hero-cta">
          <span class="hero-price">${priceLabel(g)}</span>
          <span class="hero-platforms">${platformsCount} площад${platformsCount === 1 ? "ка" : "ки"}</span>
          <button class="btn-outline" onclick="location.href='game.html?id=${g.id}'">Смотреть площадки</button>
        </div>
      </div>
      <div class="hero-img" style="background-image:url('${g.coverUrl}')"></div>
    </div>`;
}

async function loadDeals() {
  const snap = await getDocs(query(
    collection(db, "games"),
    where("bestDiscountPercent", ">", 0),
    orderBy("bestDiscountPercent", "desc"),
    limit(10)
  ));
  wrapSlider(dealsRow, docsToGames(snap).map(render).join(""));
}

async function loadGenreCounts() {
  const snap = await getDoc(doc(db, "meta", "genres"));
  const counts = snap.exists() ? snap.data().counts || {} : {};
  allGenres = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  return counts;
}

async function renderPopularCategories(counts) {
  const top = allGenres.slice(0, TOP_CATEGORIES_COUNT);
  const usedIds = new Set();
  const tiles = [];
  for (const genre of top) {
    const snap = await getDocs(query(
      collection(db, "games"),
      where("genres", "array-contains", genre),
      orderBy("randomIndex"),
      limit(10)
    ));
    const candidates = docsToGames(snap);
    const g = candidates.find(c => !usedIds.has(c.id)) || candidates[0];
    if (g) usedIds.add(g.id);
    const cover = g?.coverUrl || "";
    tiles.push(`<button class="category-tile" data-genre="${genre}" style="background-image:url('${cover}')">
      <span class="category-tile-label">${genre}</span>
      <span class="category-tile-count">${counts[genre]} игр${counts[genre] === 1 ? "а" : ""}</span>
    </button>`);
  }
  categoryTiles.innerHTML = tiles.join("");
  categoryTiles.querySelectorAll(".category-tile").forEach(btn => btn.addEventListener("click", () => {
    setGenreFilter(btn.dataset.genre);
    document.getElementById("catalog-anchor").scrollIntoView({ behavior: "smooth" });
  }));
}

function renderGenreChips() {
  genreWrap.innerHTML = `<button data-genre="all" class="chip ${catalogState.genre === "all" ? "active" : ""}">Все</button>` +
    allGenres.map(g => `<button data-genre="${g}" class="chip ${catalogState.genre === g ? "active" : ""}">${g}</button>`).join("");
  genreWrap.querySelectorAll(".chip").forEach(btn => btn.addEventListener("click", () => setGenreFilter(btn.dataset.genre)));
}

function setGenreFilter(genre) {
  catalogState.genre = genre;
  renderGenreChips();
  resetCatalog().catch(e => console.error("Не удалось применить категорию (возможно, нужен composite index — см. ссылку выше):", e));
}

async function getTotalPages() {
  const clauses = [collection(db, "games")];
  if (catalogState.genre !== "all") clauses.push(where("genres", "array-contains", catalogState.genre));
  const countSnap = await getCountFromServer(query(...clauses));
  const total = countSnap.data().count;
  catalogState.totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
}

// 1. курсоры кэшируются по мере навигации: cursors[i] — последний документ страницы i+1.
//    Прыжок на ещё не открытую страницу дозагружает недостающие курсоры по цепочке —
//    без этого Firestore не умеет "перепрыгнуть" на страницу N напрямую.
async function fetchPage(pageNum) {
  while (catalogState.cursors.length < pageNum - 1) {
    const idx = catalogState.cursors.length;
    const cursor = idx === 0 ? null : catalogState.cursors[idx - 1];
    const snap = await getDocs(buildCatalogQuery(cursor));
    if (snap.docs.length === 0) break;
    catalogState.cursors.push(snap.docs[snap.docs.length - 1]);
  }
  const cursor = pageNum === 1 ? null : catalogState.cursors[pageNum - 2];
  const snap = await getDocs(buildCatalogQuery(cursor));
  return docsToGames(snap);
}

function paginationWindow(current, total) {
  const delta = 1;
  const range = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= current - delta && i <= current + delta)) range.push(i);
  }
  const withDots = [];
  let prev = 0;
  for (const p of range) {
    if (prev && p - prev > 1) withDots.push("...");
    withDots.push(p);
    prev = p;
  }
  return withDots;
}

function renderPaginationControls() {
  const { page, totalPages } = catalogState;
  if (totalPages <= 1) { paginationEl.innerHTML = ""; return; }
  const pages = paginationWindow(page, totalPages);
  paginationEl.innerHTML = `
    <button class="page-btn" data-page="${page - 1}" ${page === 1 ? "disabled" : ""} aria-label="Предыдущая">‹</button>
    ${pages.map(p => p === "..." ? `<span class="page-ellipsis">…</span>` :
      `<button class="page-btn ${p === page ? "active" : ""}" data-page="${p}">${p}</button>`).join("")}
    <button class="page-btn" data-page="${page + 1}" ${page === totalPages ? "disabled" : ""} aria-label="Следующая">›</button>`;
  paginationEl.querySelectorAll(".page-btn[data-page]").forEach(btn => btn.addEventListener("click", () => {
    const p = Number(btn.dataset.page);
    if (p >= 1 && p <= catalogState.totalPages) goToPage(p);
  }));
}

function buildCatalogQuery(cursor) {
  const orderField = catalogState.sort === "price-asc" || catalogState.sort === "price-desc"
    ? "lowestPrice"
    : catalogState.sort === "discount-desc"
      ? "bestDiscountPercent"
      : "randomIndex";
  const direction = catalogState.sort === "price-desc" || catalogState.sort === "discount-desc" ? "desc" : "asc";

  const clauses = [collection(db, "games")];
  if (catalogState.genre !== "all") clauses.push(where("genres", "array-contains", catalogState.genre));
  clauses.push(orderBy(orderField, direction));
  if (cursor) clauses.push(startAfter(cursor));
  clauses.push(limit(PAGE_SIZE));
  return query(...clauses);
}

async function goToPage(pageNum) {
  catalogState.page = pageNum;
  const games = await fetchPage(pageNum);
  grid.innerHTML = games.map(render).join("");
  renderPaginationControls();
  document.getElementById("catalog-anchor").scrollIntoView({ behavior: "smooth" });
}

async function resetCatalog() {
  catalogState.cursors = [];
  catalogState.page = 1;
  await getTotalPages();
  const games = await fetchPage(1);
  grid.innerHTML = games.map(render).join("");
  renderPaginationControls();
}

async function runSearch(text) {
  const lower = text.toLowerCase();
  const snap = await getDocs(query(
    collection(db, "games"),
    orderBy("titleLower"),
    where("titleLower", ">=", lower),
    where("titleLower", "<=", lower + "\uf8ff"),
    limit(24)
  ));
  grid.innerHTML = docsToGames(snap).map(render).join("");
  paginationEl.innerHTML = "";
}

sortSelect.addEventListener("change", e => {
  catalogState.sort = e.target.value;
  resetCatalog();
});

let searchTimer;
searchInput.addEventListener("input", e => {
  clearTimeout(searchTimer);
  const text = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (text) runSearch(text);
    else resetCatalog();
  }, 250);
});

attachWishlistHandlers(wishlistRef);

async function init() {
  await initCurrency();

  try {
    const counts = await loadGenreCounts();
    renderGenreChips();
    await renderPopularCategories(counts);
  } catch (e) {
    console.error("Не удалось загрузить категории (возможно, нужен composite index — см. ссылку выше):", e);
  }

  try {
    await loadHeroAndPopular();
  } catch (e) {
    console.error("Не удалось загрузить hero/популярное:", e);
  }

  try {
    await loadDeals();
  } catch (e) {
    console.error("Не удалось загрузить скидки:", e);
  }

  try {
    await resetCatalog();
  } catch (e) {
    console.error("Не удалось загрузить каталог (возможно, нужен composite index — см. ссылку выше):", e);
  }
}

async function loadUserDataAndRerender(user) {
  if (!user) { ownedSlugs = new Set(); wishlistSlugs = new Set(); }
  else {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};
    ownedSlugs = new Set(data.library || []);
    wishlistSlugs = new Set(data.wishlist || []);
  }
  try { await loadHeroAndPopular(); } catch (e) { console.error(e); }
  try { await loadDeals(); } catch (e) { console.error(e); }
  try { await resetCatalog(); } catch (e) { console.error(e); }
}

onAuthStateChanged(auth, user => { loadUserDataAndRerender(user); });

init();
watchAuthUI();
initBurger();