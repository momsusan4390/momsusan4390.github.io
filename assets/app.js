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
  };
  const SPECIAL_KEYS = new Set(Object.values(COL));
  const CATEGORY_ORDER = ["냉장", "냉동", "건어물"];
  const SOLD_OUT = "품절";

  const $ = (id) => document.getElementById(id);
  const state = { items: [], category: ALL, query: "" };

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
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAMES[kind])}`;
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
      const href = safeUrl(value);
      if (href) actions.append(externalLink(key, href));
    }

    if (info["연락처"]) {
      $("footer").append(`문의 ${info["연락처"]}`);
    }
  }

  // 노출 열은 선택. 없거나 비어 있으면 노출 (상품·공지 공통)
  const HIDDEN_VALUES = ["N", "X", "숨김", "비노출", "게시중단", "중단"];
  function isVisible(row) {
    return !HIDDEN_VALUES.includes(normalizeKey(get(row, COL.visible)).toUpperCase());
  }

  // ---------- 공지사항 시트 ----------
  // 열: 등록일 | 제목 | 내용 | 링크 | 중요 | 노출
  // 중요=Y 가 맨 위, 그다음 등록일 최신순. 첫 공지만 펼쳐서 보여준다.

  const NOTICE_PREVIEW = 3;
  const isYes = (v) => ["Y", "O", "중요"].includes(v.toUpperCase());

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

    for (const [key, value] of Object.entries(item)) {
      if (!value || isSpecial(key)) continue;
      const href = safeUrl(value);
      if (href) links.append(externalLink(`${key} 보기`, href));
      else fields.append(el("dt", { textContent: key }), el("dd", { textContent: value }));
    }

    const status = get(item, COL.status);
    const soldOut = status.includes(SOLD_OUT);
    const badge = status
      ? el("span", { className: "badge" + (soldOut ? " warn" : ""), textContent: status })
      : null;

    const notes = get(item, COL.notes);
    const imgSrc = toImageUrl(get(item, COL.photo));
    const img = imgSrc
      ? el("img", { src: imgSrc, alt: get(item, COL.name), loading: "lazy", referrerPolicy: "no-referrer" })
      : el("div", { className: "img-empty", textContent: "사진 준비중" });

    return el("article", { className: "card" + (soldOut ? " sold-out" : "") }, [
      img,
      el("div", { className: "card-body" }, [
        el("div", { className: "card-head" }, [el("h3", { textContent: get(item, COL.name) || "(상품명 없음)" }), badge]),
        fields.childElementCount ? fields : null,
        notes ? el("p", { className: "notes", textContent: notes }) : null,
        links.childElementCount ? links : null,
      ]),
    ]);
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

  function renderList() {
    const q = state.query.toLowerCase();
    const filtered = state.items.filter((item) =>
      (state.category === ALL || categoryOf(item) === state.category) &&
      (!q || Object.values(item).some((v) => v.toLowerCase().includes(q)))
    );

    const groups = new Map(categories().slice(1).map((c) => [c, []]));
    for (const item of filtered) groups.get(categoryOf(item)).push(item);
    for (const [cat, items] of groups) if (!items.length) groups.delete(cat);

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

    // 공지사항·안내 탭은 없어도 상품은 표시된다
    const [itemsResult, noticesResult, infoResult] = await Promise.allSettled([
      fetchCsv("items"),
      fetchCsv("notices"),
      fetchCsv("info"),
    ]);

    if (infoResult.status === "fulfilled") renderInfo(infoResult.value);
    if (noticesResult.status === "fulfilled") renderNotices(noticesResult.value);

    if (itemsResult.status === "rejected") {
      $("status").textContent = "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      console.error(itemsResult.reason);
      return;
    }
    state.items = itemsResult.value.filter(isVisible);
    renderChips();
    renderList();
  }

  init();
})();
