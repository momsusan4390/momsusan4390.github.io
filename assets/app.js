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
  // 분류 순서 기본값. 안내 탭에 "분류 순서" 항목이 있으면 그 값이 우선 (renderInfo)
  const CATEGORY_ORDER = ["냉장", "냉동", "건어물"];
  const SOLD_OUT = "품절";

  const $ = (id) => document.getElementById(id);

  // 구형 브라우저 대비 (iOS 14 미만 등 카카오톡 인앱 포함)
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function (...nodes) { this.textContent = ""; this.append(...nodes); };
  }
  // <dialog> 미지원(iOS 15.4 미만)이면 상세 창 대신 "자세히" 보기만 사용
  const SUPPORTS_DIALOG = typeof HTMLDialogElement === "function" && "showModal" in HTMLDialogElement.prototype;

  // 보기 방식: grid(바둑판, 간단 정보) | detail(자세히, 모든 정보). 방문자 브라우저에 기억
  const VIEW_KEY = "momsusan:view";
  const loadView = () => {
    if (!SUPPORTS_DIALOG) return "detail";
    try { return localStorage.getItem(VIEW_KEY) === "detail" ? "detail" : "grid"; } catch { return "grid"; }
  };

  const state = { items: [], category: ALL, query: "", sort: "name", view: loadView(), rowIndex: new Map(), categoryOrder: CATEGORY_ORDER };

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

  // 탭마다 반드시 있어야 하는 열. 구글은 없는 탭 이름을 요청하면 오류 대신 첫 탭을 돌려주므로,
  // 이 열이 없으면 "엉뚱한 탭"으로 보고 버린다 (예: 상품게시 탭 이름이 바뀌었을 때 공지가 상품으로 보이는 문제)
  const REQUIRED_COLUMN = { items: "상품명", notices: "제목", info: "항목" };
  const FETCH_TIMEOUT_MS = 12000;
  const FETCH_RETRIES = 2; // 실패 시 추가 시도 횟수 (1초, 2초 뒤)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchCsvOnce(kind) {
    const sheetName = SHEET_NAMES[kind];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(sheetUrl(kind), { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`구글 응답 오류 ${res.status}`);
      const text = await res.text();
      // 구글이 접근 제한·로그인 안내 같은 웹페이지를 보내는 경우
      if (/^\s*</.test(text)) throw new Error("구글이 데이터 대신 안내 페이지를 보냄");
      const rows = parseCsv(text);
      const required = REQUIRED_COLUMN[kind];
      if (rows.length && !Object.keys(rows[0]).some((k) => normalizeKey(k) === required)) {
        throw new Error(`${sheetName} 탭에 "${required}" 열이 없음 (탭 이름 확인 필요)`);
      }
      return rows;
    } finally {
      clearTimeout(timer);
    }
  }

  // 일시적인 네트워크·구글 쪽 실패에 대비해 재시도. 성공하면 이 브라우저에 사본 저장
  async function fetchCsv(kind, onRetry) {
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await fetchCsvOnce(kind);
        saveCache(kind, rows);
        return rows;
      } catch (err) {
        if (attempt >= FETCH_RETRIES) throw err;
        if (onRetry) onRetry(attempt + 1);
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  function describeError(err) {
    if (!err) return "";
    if (err.name === "AbortError") return "응답 시간 초과";
    if (err instanceof TypeError) return "연결 차단 또는 끊김 (네트워크·보안 프로그램·시트 공유 설정 확인)";
    return err.message || String(err);
  }

  // ---------- 마지막으로 불러온 데이터 사본 (방문자 브라우저) ----------
  // 시트를 못 불러올 때 빈 화면 대신 마지막 사본을 저장 시각과 함께 보여준다

  const CACHE_PREFIX = "momsusan:cache:";

  function saveCache(kind, rows) {
    if (useSample) return;
    try {
      localStorage.setItem(CACHE_PREFIX + kind, JSON.stringify({ at: Date.now(), sheetId: CONFIG.sheetId, rows }));
    } catch { /* 저장 불가 브라우저는 무시 */ }
  }

  function loadCache(kind) {
    if (useSample) return null;
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_PREFIX + kind));
      return c && c.sheetId === CONFIG.sheetId && Array.isArray(c.rows) && typeof c.at === "number" ? c : null;
    } catch { return null; }
  }

  // allSettled 결과 → { rows, staleAt?, error? }. 실패하면 사본으로 대체
  function settle(result, kind) {
    if (result.status === "fulfilled") return { rows: result.value };
    const cache = loadCache(kind);
    return cache ? { rows: cache.rows, staleAt: cache.at, error: result.reason } : { rows: null, error: result.reason };
  }

  const formatTime = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function retryButton() {
    const btn = el("button", { type: "button", className: "retry", textContent: "다시 불러오기" });
    btn.addEventListener("click", () => location.reload());
    return btn;
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
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000` : url;
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
    const info = Object.fromEntries(rows.map((r) => [get(r, "항목").trim(), get(r, "내용")]).filter(([k]) => k));
    // 항목 이름도 띄어쓰기 무시 ("업체 명" = "업체명")
    const infoGet = (name) => (Object.entries(info).find(([k]) => normalizeKey(k) === name) || [])[1] || "";

    // 상단 이름은 로고 이미지로 고정. 업체명은 브라우저 탭 제목에만 반영
    if (infoGet("업체명")) document.title = infoGet("업체명");
    $("intro").textContent = infoGet("소개");
    $("updated").textContent = infoGet("기준일") ? `${infoGet("기준일")} 기준` : "";

    // 분류 순서: "냉장, 냉동, 건어물, 젓갈" 처럼 쉼표(또는 · / 줄바꿈)로 구분
    const order = infoGet("분류순서").split(/[,，·/\n]+/).map((s) => s.trim()).filter(Boolean);
    if (order.length) state.categoryOrder = order;

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
    "소개", "기준일", "카카오톡", "분류순서",
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

  // 날짜 → 20261021 같은 숫자 (2026-10-21, 2026. 10. 1, 2026/9/5 모두 인식). 못 읽으면 0
  function dateKey(v) {
    const m = String(v || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
  }

  function renderNotices(rows) {
    const notices = rows
      .filter((r) => isVisible(r) && (get(r, "제목") || get(r, "내용")))
      .map((r, index) => ({ r, index }))
      .sort((a, b) =>
        isYes(get(b.r, "중요")) - isYes(get(a.r, "중요")) ||
        dateKey(get(b.r, "등록일")) - dateKey(get(a.r, "등록일")) ||
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
      // 숨김은 li 에 걸어야 구분선(li + li 테두리)이 겹치지 않는다
      return el("li", { hidden: i >= NOTICE_PREVIEW }, el("details", { open: i === 0 }, [summary, body]));
    });

    $("notice-list").replaceChildren(...items);
    $("notices").hidden = false;

    const more = $("notice-more");
    if (notices.length > NOTICE_PREVIEW) {
      more.textContent = `이전 공지 ${notices.length - NOTICE_PREVIEW}건 더보기`;
      more.hidden = false;
      more.addEventListener("click", () => {
        items.forEach((li) => { li.hidden = false; });
        more.hidden = true;
      }, { once: true });
    }
  }

  // ---------- 상품 시트 ----------

  // inModal: 상세 창 안에 그릴 때 (클릭 시 다시 창을 열지 않음)
  function renderCard(item, { inModal = false } = {}) {
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
    const emptyPhoto = () => el("div", { className: "img-empty", textContent: "사진 준비중" });
    const img = imgSrc
      ? el("img", { src: imgSrc, alt: get(item, COL.name), loading: "lazy", referrerPolicy: "no-referrer" })
      : emptyPhoto();
    // 드라이브 공유 누락·잘못된 링크로 사진을 못 불러오면 깨진 아이콘 대신 "사진 준비중"
    if (imgSrc) img.addEventListener("error", () => img.replaceWith(emptyPhoto()), { once: true });

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
    if (inModal) return card;
    card.dataset.name = get(item, COL.name);
    // 바둑판: 카드를 누르면 상세 창 / 자세히: 이미 다 보이므로 최근 본 상품에만 기록
    card.addEventListener("click", () => (state.view === "grid" ? openDetail(item) : recordView(item)));
    if (state.view === "grid") {
      // 키보드(Tab → Enter/Space)로도 상세 창을 열 수 있게
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `${get(item, COL.name)} 자세히 보기`);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(item); }
      });
    }
    return card;
  }

  // ---------- 상품 상세 창 ----------

  let focusBeforeDetail = null;

  function openDetail(item) {
    if (!SUPPORTS_DIALOG) return recordView(item);
    $("detail-body").replaceChildren(renderCard(item, { inModal: true }));
    setRecentOpen(false);
    const dlg = $("detail");
    if (!dlg.open) {
      focusBeforeDetail = document.activeElement;
      dlg.showModal();
    }
    dlg.scrollTop = 0;
    document.documentElement.classList.add("modal-open");
    recordView(item);
  }

  function initDetail() {
    if (!SUPPORTS_DIALOG) return;
    const dlg = $("detail");
    $("detail-close").addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // 바깥(어두운 영역) 클릭
    dlg.addEventListener("close", () => {
      document.documentElement.classList.remove("modal-open");
      // 닫으면 열기 전 위치(누른 카드)로 포커스 복귀
      if (focusBeforeDetail && document.contains(focusBeforeDetail)) focusBeforeDetail.focus();
      focusBeforeDetail = null;
    });
  }

  // ---------- 보기 전환 ----------

  function setView(view) {
    state.view = SUPPORTS_DIALOG ? view : "detail";
    try { localStorage.setItem(VIEW_KEY, state.view); } catch { /* 저장 불가 브라우저는 무시 */ }
    for (const btn of document.querySelectorAll("[data-view]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.view === state.view));
    }
    $("list").className = `view-${state.view}`;
    // 카드의 키보드·역할 속성이 보기 방식마다 달라서 다시 그림
    if (state.items.length) renderList();
  }

  // ---------- 가격 표기 ----------
  // 공급가: 회색 + 취소선 / 할인율: 빨간색, 판매가 앞 / 판매가: 크게
  // 할인율 칸이 비어 있으면 공급가·판매가로 계산. 판매가가 없으면 공급가를 본 가격으로 표시

  // "₩21,000" "21000원" "2.1만원" "10.5%" → 숫자. 범위(1,000~2,000)·음수·0·알 수 없는 형식은 null
  function toNumber(v) {
    const s = String(v || "").replace(/[₩,원%\s]/g, "");
    const m = s.match(/^(\d+(?:\.\d+)?)(만)?$/);
    if (!m) return null;
    const n = Number(m[1]) * (m[2] ? 10000 : 1);
    return n > 0 ? n : null;
  }
  const won = (n) => `${Math.round(n).toLocaleString("ko-KR")}원`;
  // 10 → "10%", 10.5 → "10.5%" (소수 첫째 자리까지)
  const percent = (n) => `${Math.round(n * 10) / 10}%`;

  function priceInfo(item) {
    const supply = toNumber(get(item, COL.supply));
    const sale = toNumber(get(item, COL.sale));
    const main = sale ?? supply;
    const original = sale !== null && supply !== null && supply > sale ? supply : null;

    // 할인율은 실제 할인(판매가 < 공급가)일 때만 표시. 시트 값이 0~100 사이가 아니면 자동 계산.
    // 계산값이 반올림으로 0% 가 되면(아주 작은 할인) 표시하지 않음
    let discount = "";
    if (original) {
      const entered = toNumber(get(item, COL.discount));
      const rate = entered !== null && entered < 100 ? entered : Math.round(((original - sale) / original) * 100);
      if (rate > 0) discount = percent(rate);
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

  // 저장값이 손상돼도(배열 아님 등) 기능이 멈추지 않게 문자열 배열만 사용
  function loadRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY));
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch { return []; }
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
    $("fab-recent").setAttribute("aria-label", `최근 본 상품 ${recent.length}개`);
  }

  // 바둑판 보기: 상세 창으로 열기 / 자세히 보기: 목록의 해당 카드로 이동 (필터·검색에 가려져 있으면 해제)
  function goToItem(name) {
    if (state.view === "grid") {
      const item = state.items.find((i) => get(i, COL.name) === name);
      if (item) openDetail(item);
      return;
    }
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
    setRecentOpen(false);
    // 상단 고정 검색바 높이만큼 띄워서 카드 윗부분이 가려지지 않게
    card.style.scrollMarginTop = `${document.querySelector(".toolbar").offsetHeight + 12}px`;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    card.classList.remove("flash");
    void card.offsetWidth; // 애니메이션 재시작
    card.classList.add("flash");
  }

  // ---------- 우측 하단 고정 버튼 ----------

  function setRecentOpen(open) {
    $("recent-panel").hidden = !open;
    $("fab-recent").setAttribute("aria-expanded", String(open));
  }

  function initFab() {
    const panel = $("recent-panel");
    $("fab-recent").addEventListener("click", (e) => {
      e.stopPropagation();
      setRecentOpen(panel.hidden);
    });
    $("recent-close").addEventListener("click", () => setRecentOpen(false));
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => setRecentOpen(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) setRecentOpen(false); });

    $("fab-top").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  // 카카오톡 문의 주소: config.js kakaoUrl 우선, 없으면 안내 탭의 "카카오톡" 항목. 둘 다 없으면 버튼 숨김
  function setKakao(url) {
    const href = safeUrl(url || "");
    if (!href) return;
    $("fab-kakao").href = href;
    $("fab-kakao").hidden = false;
  }

  // 분류 순서 목록(안내 탭 "분류 순서", 없으면 냉장 → 냉동 → 건어물)대로 정렬.
  // 목록에 없는 분류는 그 뒤에 시트에 처음 나온 순서대로. 띄어쓰기는 무시하고 비교
  function categories() {
    const seen = [...new Set(state.items.map(categoryOf))];
    const order = state.categoryOrder.map(normalizeKey);
    const rank = (c) => {
      const i = order.indexOf(normalizeKey(c));
      return i === -1 ? order.length : i;
    };
    return [ALL, ...seen.sort((a, b) => rank(a) - rank(b))];
  }

  function renderChips() {
    const chips = $("chips");
    chips.replaceChildren(...categories().map((name) => {
      const btn = el("button", { type: "button", textContent: name });
      btn.setAttribute("aria-pressed", String(name === state.category));
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
    dateKey(get(b, "등록일")) - dateKey(get(a, "등록일")) ||
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

  // 검색 대상: 화면에 글자로 보이는 값만 (사진·상세사진 등 링크 주소, 노출 열 제외)
  const searchText = (item) =>
    Object.entries(item)
      .filter(([k, v]) => v && normalizeKey(k) !== COL.visible && !safeUrl(v))
      .map(([, v]) => v.toLowerCase())
      .join("\n");

  function renderList() {
    const q = state.query.toLowerCase();
    const filtered = state.items.filter((item) =>
      (state.category === ALL || categoryOf(item) === state.category) &&
      (!q || searchText(item).includes(q))
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
        el("div", { className: "grid" }, items.map((item) => renderCard(item))),
      ])
    ));
    $("count").textContent = `총 ${filtered.length}개`;
    $("status").textContent = filtered.length ? "" : "조건에 맞는 품목이 없습니다.";
  }

  // ---------- 시작 ----------

  async function init() {
    $("search").addEventListener("input", (e) => { state.query = e.target.value.trim(); renderList(); });
    $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    for (const btn of document.querySelectorAll("[data-view]")) {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    }
    if (!SUPPORTS_DIALOG) document.querySelector(".view-toggle").hidden = true;
    setView(state.view);
    initDetail();
    initFab();
    setKakao(CONFIG.kakaoUrl);

    // 공지사항·안내 탭은 없어도 상품은 표시된다
    const onItemsRetry = (n) => { $("status").textContent = `연결이 원활하지 않아 다시 시도하는 중… (${n}/${FETCH_RETRIES})`; };
    const results = await Promise.allSettled([
      fetchCsv("items", onItemsRetry),
      fetchCsv("notices"),
      fetchCsv("info"),
    ]);
    const [items, notices, info] = [
      settle(results[0], "items"),
      settle(results[1], "notices"),
      settle(results[2], "info"),
    ];
    for (const r of [items, notices, info]) if (r.error) console.warn(r.error);

    if (info.rows) {
      renderInfo(info.rows);
      if (!CONFIG.kakaoUrl) {
        const row = info.rows.find((r) => normalizeKey(get(r, "항목")) === "카카오톡");
        if (row) setKakao(get(row, "내용"));
      }
    }
    if (notices.rows) renderNotices(notices.rows);

    if (!items.rows) {
      $("status").replaceChildren(
        "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. ",
        retryButton(),
        el("small", { className: "status-reason", textContent: `원인: ${describeError(items.error)}` })
      );
      return;
    }

    // 사본으로 대신 보여주는 중이면 안내
    const staleAt = Math.min(...[items, notices, info].map((r) => r.staleAt || Infinity));
    if (Number.isFinite(staleAt)) {
      $("stale").replaceChildren(
        `인터넷 연결이 불안정해 최신 정보를 불러오지 못했어요. ${formatTime(staleAt)}에 저장된 정보를 보여드려요. `,
        retryButton()
      );
      $("stale").hidden = false;
    }

    state.items = items.rows.filter(isVisible);
    state.items.forEach((item, i) => state.rowIndex.set(item, i));
    renderChips();
    renderList();
    renderRecent();
  }

  init();
})();
