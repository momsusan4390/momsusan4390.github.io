// 엄마수산 — 구글 시트를 읽어 고객사용 열람 페이지를 그린다.
// 시트 내용은 전부 textContent 로만 넣는다 (innerHTML 금지).
(function () {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const ALL = "전체";

  // 상품 시트에서 의미가 정해진 열. 나머지 열은 카드에 "열이름: 값" 으로 그대로 표시된다.
  // 열 이름은 띄어쓰기를 무시하고 비교한다 ("상품 분류" = "상품분류").
  const COL = {
    visible: "노출",
    category: "상품분류",
    name: "상품명",
    status: "판매상태",
    photo: "대표사진",
    notes: "안내사항",
    supply: "공급가",
    sale: "판매가",
    discount: "할인율",
  };
  const SPECIAL_KEYS = new Set(Object.values(COL));
  const CATEGORY_ORDER = ["냉장", "냉동", "건어물"];
  const SOLD_OUT = "품절";

  const $ = (id) => document.getElementById(id);
  const state = { items: [], category: ALL, query: "", sort: "name", rowIndex: new Map() };

  const normalizeKey = (key) => key.replace(/\s+/g, "");
  const isSpecial = (key) => SPECIAL_KEYS.has(normalizeKey(key));
  const get = (item, col) => {
    const key = Object.keys(item).find((k) => normalizeKey(k) === col);
    return key ? item[key] : "";
  };
  const categoryOf = (item) => get(item, COL.category) || "기타";

  // ---------- 데이터 로딩 ----------

  // kind: "items" | "notices" | "info" — config.js 의 탭 이름, sample/{kind}.csv 와 대응
  const SHEET_NAMES = {
    items: CONFIG.itemsSheet || "상품게시",
    notices: CONFIG.noticeSheet || "공지사항",
    info: CONFIG.infoSheet || "안내",
  };

  // 주소 뒤에 ?sample 을 붙이면 시트 대신 샘플 데이터로 화면 확인
  const useSample = !CONFIG.sheetId || new URLSearchParams(location.search).has("sample");

  function sheetUrl(kind) {
    if (useSample) return `sample/${kind}.csv`;
    const id = encodeURIComponent(CONFIG.sheetId);
    // headers=1: 첫 행만 헤더. 생략하면 구글이 글자만 있는 위쪽 여러 행을 헤더 하나로 합쳐 버린다 (안내 탭에서 발생)
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(SHEET_NAMES[kind])}`;
  }

  async function fetchCsv(kind) {
    const sheetName = SHEET_NAMES[kind];
    const res = await fetch(sheetUrl(kind), { cache: "no-store" });
    if (!res.ok) throw new Error(`${sheetName} 시트를 불러오지 못했습니다 (${res.status})`);
    return parseCsv(await res.text());
  }

  // RFC 4180 CSV → 객체 배열 (첫 줄 = 헤더)
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }

    const [header = [], ...body] = rows;
    const keys = header.map((h) => h.trim());
    return body
      .filter((r) => r.some((v) => v.trim()))
      .map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || "").trim()])))
      .map((obj) => { delete obj[""]; return obj; });
  }

  // ---------- 링크 처리 ----------

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch { return null; }
  }

  // 구글 드라이브 공유 링크 → 이미지로 표시 가능한 썸네일 주소
  function toImageUrl(value) {
    const url = safeUrl(value);
    if (!url) return null;
    const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]{10,})/);
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w800` : url;
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
  }

  function externalLink(label, href) {
    return el("a", { href, textContent: label, target: "_blank", rel: "noopener noreferrer" });
  }

  // ---------- 안내 시트 ----------

  function renderInfo(rows) {
    const info = Object.fromEntries(rows.map((r) => [r["항목"], r["내용"]]).filter(([k]) => k));

    // 상단 이름은 로고 이미지로 고정. 업체명은 브라우저 탭 제목에만 반영
    if (info["업체명"]) document.title = info["업체명"];
    $("intro").textContent = info["소개"] || "";
    $("updated").textContent = info["기준일"] ? `${info["기준일"]} 기준` : "";

    // 값이 URL 인 항목은 상단 버튼으로
    const actions = $("hero-actions");
    for (const [key, value] of Object.entries(info)) {
      if (normalizeKey(key) === "카카오톡") continue; // 우측 하단 문의 버튼으로 표시
      const href = safeUrl(value);
      if (href) actions.append(externalLink(key, href));
    }

    renderFooter(info);
  }

  // ---------- 하단 (안내 탭 기반) ----------
  // 줄 구성 고정: [상호명 | 대표자] / [주소] / [사업자등록번호 | 고객센터 | 이메일] / [영업시간]
  // 값은 안내 탭에서 가져오고, 비어 있는 항목·줄은 생략. 그 밖의 추가 항목은 마지막 줄에 나열
  const FOOTER_LINES = [
    ["상호명", "대표자"],
    ["주소"],
    ["사업자등록번호", "고객센터", "이메일"],
    ["영업시간"],
  ];
  const FOOTER_ALIASES = { 상호명: ["상호명", "업체명"], 고객센터: ["고객센터", "연락처"] };
  // 고정 줄에서 쓰는 키(별칭 포함) + 상단·문의 버튼용 키는 추가 항목에서 제외
  const FOOTER_SKIP = new Set([
    "소개", "기준일", "카카오톡",
    ...FOOTER_LINES.flat().flatMap((l) => FOOTER_ALIASES[l] || [l]),
  ]);

  function renderFooter(info) {
    const lookup = new Map(Object.entries(info).map(([k, v]) => [normalizeKey(k), v]));
    const valueOf = (label) =>
      (FOOTER_ALIASES[label] || [label]).map((k) => lookup.get(k)).find(Boolean) || "";

    const lines = FOOTER_LINES.map((labels) => labels.map((l) => [l, valueOf(l)]).filter(([, v]) => v));
    lines.push([...lookup].filter(([k, v]) => v && !FOOTER_SKIP.has(k) && !safeUrl(v)));

    $("footer-info").replaceChildren(...lines.filter((l) => l.length).map((items) =>
      el("p", { className: "footer-line" }, items.map(([label, value]) =>
        el("span", { className: "footer-item" }, [el("span", { className: "footer-label", textContent: label }), value])
      ))
    ));

    const name = valueOf("상호명") || "엄마수산";
    $("footer-copy").textContent = `© ${new Date().getFullYear()} ${name}. All rights reserved.`;
  }

  // 노출 열은 선택. 없거나 비어 있으면 노출 (상품·공지 공통)
  // 노출 열을 체크박스로 바꿔도 동작하도록 FALSE(체크 해제)도 숨김 처리
  const HIDDEN_VALUES = ["N", "X", "FALSE", "숨김", "비노출", "게시중단", "중단"];
  function isVisible(row) {
    return !HIDDEN_VALUES.includes(normalizeKey(get(row, COL.visible)).toUpperCase());
  }

  // ---------- 공지사항 시트 ----------
  // 열: 등록일 | 제목 | 내용 | 링크 | 중요 | 노출
  // 중요=Y 가 맨 위, 그다음 등록일 최신순. 첫 공지만 펼쳐서 보여준다.

  const NOTICE_PREVIEW = 3;
  // 체크박스는 TRUE/FALSE 로 들어온다
  const isYes = (v) => ["Y", "O", "TRUE", "중요"].includes(v.trim().toUpperCase());

  function renderNotices(rows) {
    const notices = rows
      .filter((r) => isVisible(r) && (get(r, "제목") || get(r, "내용")))
      .map((r, index) => ({ r, index }))
      .sort((a, b) =>
        isYes(get(b.r, "중요")) - isYes(get(a.r, "중요")) ||
        get(b.r, "등록일").localeCompare(get(a.r, "등록일")) ||
        a.index - b.index
      )
      .map(({ r }) => r);
    if (!notices.length) return;

    const items = notices.map((r, i) => {
      const href = safeUrl(get(r, "링크"));
      const summary = el("summary", {}, [
        isYes(get(r, "중요")) ? el("span", { className: "badge warn", textContent: "중요" }) : null,
        el("span", { className: "notice-title", textContent: get(r, "제목") || "공지" }),
        el("span", { className: "notice-date", textContent: get(r, "등록일") }),
      ]);
      const body = el("div", { className: "notice-body" }, [
        get(r, "내용") ? el("p", { textContent: get(r, "내용") }) : null,
        href ? externalLink("자세히 보기", href) : null,
      ]);
      const details = el("details", { open: i === 0, hidden: i >= NOTICE_PREVIEW }, [summary, body]);
      return el("li", {}, details);
    });

    $("notice-list").replaceChildren(...items);
    $("notices").hidden = false;

    const more = $("notice-more");
    if (notices.length > NOTICE_PREVIEW) {
      more.textContent = `이전 공지 ${notices.length - NOTICE_PREVIEW}건 더보기`;
      more.hidden = false;
      more.addEventListener("click", () => {
        items.forEach((li) => { li.firstChild.hidden = false; });
        more.hidden = true;
      }, { once: true });
    }
  }

  // ---------- 상품 시트 ----------

  function renderCard(item) {
    const fields = el("dl", { className: "fields" });
    const links = el("div", { className: "links" });
    const status = get(item, COL.status);
    const soldOut = isSoldOut(item);

    for (const [key, value] of Object.entries(item)) {
      if (!value || isSpecial(key)) continue;
      const href = safeUrl(value);
      // 품절 상품은 링크가 있어도 버튼만 보이고 눌리지 않게
      if (href && soldOut) links.append(el("span", { className: "link-disabled", textContent: `${key} 보기`, title: "품절 상품입니다" }));
      else if (href) links.append(externalLink(`${key} 보기`, href));
      else fields.append(el("dt", { textContent: key }), el("dd", { textContent: value }));
    }

    const badge = status
      ? el("span", { className: "badge" + (soldOut ? " warn" : ""), textContent: status })
      : null;

    const price = renderPrice(item);
    const notes = get(item, COL.notes);
    const imgSrc = toImageUrl(get(item, COL.photo));
    const img = imgSrc
      ? el("img", { src: imgSrc, alt: get(item, COL.name), loading: "lazy", referrerPolicy: "no-referrer" })
      : el("div", { className: "img-empty", textContent: "사진 준비중" });

    const card = el("article", { className: "card" + (soldOut ? " sold-out" : "") }, [
      img,
      el("div", { className: "card-body" }, [
        el("div", { className: "card-head" }, [el("h3", { textContent: get(item, COL.name) || "(상품명 없음)" }), badge]),
        price,
        fields.childElementCount ? fields : null,
        notes ? el("p", { className: "notes", textContent: notes }) : null,
        links.childElementCount ? links : null,
      ]),
    ]);
    card.dataset.name = get(item, COL.name);
    card.addEventListener("click", () => recordView(item));
    return card;
  }

  // ---------- 가격 표기 ----------
  // 공급가: 회색 + 취소선 / 할인율: 빨간색, 판매가 앞 / 판매가: 크게
  // 할인율 칸이 비어 있으면 공급가·판매가로 계산. 판매가가 없으면 공급가를 본 가격으로 표시

  const toNumber = (v) => {
    const n = parseInt(String(v || "").replace(/[^\d]/g, ""), 10);
    return Number.isNaN(n) ? null : n;
  };
  const won = (n) => `${n.toLocaleString("ko-KR")}원`;

  function priceInfo(item) {
    const supply = toNumber(get(item, COL.supply));
    const sale = toNumber(get(item, COL.sale));
    const main = sale ?? supply;
    const original = sale !== null && supply !== null && supply > sale ? supply : null;

    // 할인율은 실제 할인(판매가 < 공급가)일 때만 표시. 시트의 "0%" 등은 무시
    let discount = "";
    if (original) {
      const entered = toNumber(get(item, COL.discount));
      discount = `${entered || Math.round(((original - sale) / original) * 100)}%`;
    }

    return { main, original, discount };
  }

  function renderPrice(item) {
    const { main, original, discount } = priceInfo(item);
    if (main === null) return null;
    return el("div", { className: "price" }, [
      original ? el("del", { className: "price-original", textContent: won(original) }) : null,
      el("div", { className: "price-now" }, [
        discount ? el("span", { className: "price-discount", textContent: discount }) : null,
        el("strong", { className: "price-sale", textContent: won(main) }),
      ]),
    ]);
  }

  // ---------- 최근 본 상품 (이 브라우저에만 저장) ----------
  // 상품 카드를 누르면(상세사진 보기 포함) 기록. 시트에서 사라진 상품은 목록에서 자동 제외

  const RECENT_KEY = "momsusan:recent";
  const RECENT_MAX = 10;

  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  }

  function recordView(item) {
    const name = get(item, COL.name);
    if (!name) return;
    const names = [name, ...loadRecent().filter((n) => n !== name)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(names)); } catch { /* 저장 불가 브라우저는 무시 */ }
    renderRecent();
  }

  function renderRecent() {
    const itemsByName = new Map(state.items.map((i) => [get(i, COL.name), i]));
    const recent = loadRecent().map((n) => itemsByName.get(n)).filter(Boolean);

    $("recent-list").replaceChildren(...recent.map((item) => {
      const btn = el("button", { type: "button" }, [
        el("span", { className: "recent-name", textContent: get(item, COL.name) }),
        el("span", { className: "recent-meta", textContent: [priceOf(item) !== null && won(priceOf(item)), get(item, COL.status)].filter(Boolean).join(" · ") }),
      ]);
      btn.addEventListener("click", () => goToItem(get(item, COL.name)));
      return el("li", {}, btn);
    }));
    $("recent-empty").hidden = recent.length > 0;
    $("recent-count").textContent = recent.length;
    $("recent-count").hidden = recent.length === 0;
  }

  // 목록에서 해당 상품 카드로 이동 (필터·검색에 가려져 있으면 해제)
  function goToItem(name) {
    const find = () => [...document.querySelectorAll(".card")].find((c) => c.dataset.name === name);
    if (!find()) {
      state.category = ALL;
      state.query = "";
      $("search").value = "";
      renderChips();
      renderList();
    }
    const card = find();
    if (!card) return;
    $("recent-panel").hidden = true;
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("flash");
    void card.offsetWidth; // 애니메이션 재시작
    card.classList.add("flash");
  }

  // ---------- 우측 하단 고정 버튼 ----------

  function initFab() {
    const panel = $("recent-panel");
    $("fab-recent").addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    });
    $("recent-close").addEventListener("click", () => { panel.hidden = true; });
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { panel.hidden = true; });

    $("fab-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // 카카오톡 문의 주소: config.js kakaoUrl 우선, 없으면 안내 탭의 "카카오톡" 항목. 둘 다 없으면 버튼 숨김
  function setKakao(url) {
    const href = safeUrl(url || "");
    if (!href) return;
    $("fab-kakao").href = href;
    $("fab-kakao").hidden = false;
  }

  // 냉장 → 냉동 → 건어물 순, 그 외 분류는 시트에 나온 순서대로 뒤에
  function categories() {
    const seen = [...new Set(state.items.map(categoryOf))];
    const rank = (c) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
    return [ALL, ...seen.sort((a, b) => rank(a) - rank(b))];
  }

  function renderChips() {
    const chips = $("chips");
    chips.replaceChildren(...categories().map((name) => {
      const btn = el("button", { type: "button", textContent: name });
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(name === state.category));
      btn.addEventListener("click", () => { state.category = name; renderChips(); renderList(); });
      return btn;
    }));
    chips.hidden = categories().length <= 2;
  }

  // ---------- 정렬 (분류 그룹 안에서 적용) ----------
  // 신상품: "등록일" 열이 있으면 그 날짜 최신순, 없으면 시트 아래쪽(나중에 추가한 행)이 먼저
  // 가격: 화면에 크게 보이는 가격(판매가, 없으면 공급가) 기준. 둘 다 비어 있으면 맨 뒤

  const priceOf = (item) => priceInfo(item).main;
  const byName = (a, b) => get(a, COL.name).localeCompare(get(b, COL.name), "ko");
  const byNewest = (a, b) =>
    get(b, "등록일").localeCompare(get(a, "등록일")) ||
    state.rowIndex.get(b) - state.rowIndex.get(a);
  const byPrice = (dir) => (a, b) => {
    const pa = priceOf(a), pb = priceOf(b);
    if (pa === null || pb === null) return (pa === null) - (pb === null);
    return (pa - pb) * dir || byName(a, b);
  };

  const SORTS = {
    name: byName,
    new: byNewest,
    priceAsc: byPrice(1),
    priceDesc: byPrice(-1),
  };

  // 품절 상품은 판매중 상품 뒤로. 판매중·품절 각각 안에서는 선택한 정렬 적용
  const isSoldOut = (item) => get(item, COL.status).includes(SOLD_OUT);
  const withSoldOutLast = (compare) => (a, b) => isSoldOut(a) - isSoldOut(b) || compare(a, b);

  function renderList() {
    const q = state.query.toLowerCase();
    const filtered = state.items.filter((item) =>
      (state.category === ALL || categoryOf(item) === state.category) &&
      (!q || Object.values(item).some((v) => v.toLowerCase().includes(q)))
    );

    const groups = new Map(categories().slice(1).map((c) => [c, []]));
    for (const item of filtered) groups.get(categoryOf(item)).push(item);
    for (const [cat, items] of groups) {
      if (items.length) items.sort(withSoldOutLast(SORTS[state.sort]));
      else groups.delete(cat);
    }

    $("list").replaceChildren(...[...groups].map(([cat, items]) =>
      el("section", { className: "group" }, [
        el("h2", { textContent: `${cat} (${items.length})` }),
        el("div", { className: "grid" }, items.map(renderCard)),
      ])
    ));
    $("status").textContent = filtered.length ? "" : "조건에 맞는 품목이 없습니다.";
  }

  // ---------- 시작 ----------

  async function init() {
    $("search").addEventListener("input", (e) => { state.query = e.target.value.trim(); renderList(); });
    $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    initFab();
    setKakao(CONFIG.kakaoUrl);

    // 공지사항·안내 탭은 없어도 상품은 표시된다
    const [itemsResult, noticesResult, infoResult] = await Promise.allSettled([
      fetchCsv("items"),
      fetchCsv("notices"),
      fetchCsv("info"),
    ]);

    if (infoResult.status === "fulfilled") {
      renderInfo(infoResult.value);
      if (!CONFIG.kakaoUrl) {
        const row = infoResult.value.find((r) => normalizeKey(r["항목"] || "") === "카카오톡");
        if (row) setKakao(row["내용"]);
      }
    }
    if (noticesResult.status === "fulfilled") renderNotices(noticesResult.value);

    if (itemsResult.status === "rejected") {
      $("status").textContent = "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      console.error(itemsResult.reason);
      return;
    }
    state.items = itemsResult.value.filter(isVisible);
    state.items.forEach((item, i) => state.rowIndex.set(item, i));
    renderChips();
    renderList();
    renderRecent();
  }

  init();
})();
