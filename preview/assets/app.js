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
    storage: "보관",       // 당일생물 / 냉장 / 냉동 / 상온 → 사진 위 색 배지 + 보관 필터
    rec: "추천",           // 체크 → "이달의 주력상품" + 추천 배지
    season: "제철",        // 체크 → "제철 상품" + 제철 배지
    sameDay: "당일출고",   // 체크 → 당일출고 배지
  };
  // 보관 방식 표시 순서와 배지 색 이름
  const STORAGE_ORDER = ["당일생물", "냉장", "냉동", "상온"];
  const STORAGE_CLASS = { 당일생물: "live", 냉장: "cold", 냉동: "frozen", 상온: "room" };
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

  const state = {
    items: [], category: ALL, storage: ALL, query: "", sort: "name", view: loadView(),
    rowIndex: new Map(), categoryOrder: CATEGORY_ORDER, kakaoUrl: "",
  };
  const PAGE = document.body.dataset.page || "home"; // home | order | notices | legal

  const normalizeKey = (key) => key.replace(/\s+/g, "");
  const isSpecial = (key) => SPECIAL_KEYS.has(normalizeKey(key));
  // 열 이름은 띄어쓰기를 무시하고 찾는다 (요청 쪽 이름에 띄어쓰기가 있어도 됨)
  const get = (item, col) => {
    const want = normalizeKey(col);
    const key = Object.keys(item).find((k) => normalizeKey(k) === want);
    return key ? item[key] : "";
  };
  const categoryOf = (item) => get(item, COL.category) || "기타";
  const storageOf = (item) => get(item, COL.storage).trim();

  // ---------- 데이터 로딩 ----------

  // kind: "items" | "notices" | "info" — config.js 의 탭 이름, sample/{kind}.csv 와 대응
  const SHEET_NAMES = {
    items: CONFIG.itemsSheet || "상품게시",
    notices: CONFIG.noticeSheet || "공지사항",
    info: CONFIG.infoSheet || "안내",
    banners: CONFIG.bannerSheet || "배너",
    order: CONFIG.orderSheet || "주문방법",
  };

  // 내 컴퓨터(localhost)에서 주소 뒤에 ?sample 을 붙이면 시트 대신 샘플 데이터로 화면 확인
  const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
  const useSample = !CONFIG.sheetId || (isLocal && new URLSearchParams(location.search).has("sample"));

  function sheetUrl(kind) {
    if (useSample) return `sample/${kind}.csv`;
    const id = encodeURIComponent(CONFIG.sheetId);
    // headers=1: 첫 행만 헤더. 생략하면 구글이 글자만 있는 위쪽 여러 행을 헤더 하나로 합쳐 버린다 (안내 탭에서 발생)
    return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(SHEET_NAMES[kind])}`;
  }

  // 탭마다 반드시 있어야 하는 열. 구글은 없는 탭 이름을 요청하면 오류 대신 첫 탭을 돌려주므로,
  // 이 열이 없으면 "엉뚱한 탭"으로 보고 버린다 (예: 상품게시 탭 이름이 바뀌었을 때 공지가 상품으로 보이는 문제)
  const REQUIRED_COLUMN = { items: "상품명", notices: "제목", info: "항목", banners: "이미지", order: "제목" };
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

  // 불러오기 실패 문구 + 다시 불러오기 + 원인
  function showLoadError(box, error) {
    box.replaceChildren(
      "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요. ",
      retryButton(),
      el("small", { className: "status-reason", textContent: `원인: ${describeError(error)}` })
    );
  }

  // 사본으로 대신 보여주는 중이면 저장 시각 안내 (사본이 없으면 아무것도 안 함)
  function showStale(box, results) {
    const staleAt = Math.min(...results.map((r) => r.staleAt || Infinity));
    if (!Number.isFinite(staleAt)) return;
    box.replaceChildren(
      `인터넷 연결이 불안정해 최신 정보를 불러오지 못했어요. ${formatTime(staleAt)}에 저장된 정보를 보여드려요. `,
      retryButton()
    );
    box.hidden = false;
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

  // 구글 드라이브 공유 링크 → 이미지로 표시 가능한 썸네일 주소 (width: 불러올 가로 크기)
  function toImageUrl(value, width = 1000) {
    const url = safeUrl(value);
    if (!url) return null;
    const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([\w-]{10,})/);
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w${width}` : url;
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

    // 상단 이름은 로고 이미지, 브라우저 탭 제목은 HTML 의 "엄마수산"으로 고정
    if ($("intro")) $("intro").textContent = infoGet("소개");
    if ($("updated")) $("updated").textContent = infoGet("기준일") ? `${infoGet("기준일")} 기준` : "";

    // 분류 순서: "냉장, 냉동, 건어물, 젓갈" 처럼 쉼표(또는 / 줄바꿈)로 구분. 분류 이름에 · 이 들어갈 수 있어 · 는 구분자로 쓰지 않음
    const order = infoGet("분류순서").split(/[,，/\n]+/).map((s) => s.trim()).filter(Boolean);
    if (order.length) state.categoryOrder = order;

    // 값이 URL 인 항목은 상단 버튼으로 (카카오톡·약관 링크는 제자리가 따로 있어 제외)
    const actions = $("hero-actions");
    if (actions) {
      for (const [key, value] of Object.entries(info)) {
        if (INFO_LINK_KEYS.has(normalizeKey(key))) continue;
        const href = safeUrl(value);
        if (href) actions.append(externalLink(key, href));
      }
    }

    renderCustomerCenter(infoGet);
    renderFooter(info);
  }

  // 상단 버튼으로 만들지 않는 링크 항목: 카카오톡(문의 버튼), 이용약관·개인정보처리방침(하단 링크)
  const INFO_LINK_KEYS = new Set(["카카오톡", "이용약관", "개인정보처리방침"]);

  // ---------- 고객센터 안내 블록 ----------
  function renderCustomerCenter(infoGet) {
    const box = $("cs");
    if (!box) return;
    const hours = infoGet("영업시간") || infoGet("고객센터운영시간");
    const phone = infoGet("고객센터") || infoGet("연락처");
    $("cs-hours").textContent = hours ? `운영시간 ${hours}` : "";
    $("cs-phone").textContent = phone ? `전화 ${phone}` : "";
    $("cs-hours").hidden = !hours;
    $("cs-phone").hidden = !phone;

    // 이메일 주문·문의: 안내 탭 "주문 이메일"(없으면 "이메일")
    const email = (infoGet("주문이메일") || infoGet("이메일")).trim();
    const valid = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email);
    const subject = PAGE === "order" ? "[엄마수산] 주문" : "[엄마수산] 문의";
    if ($("cs-email")) {
      if (valid) $("cs-email").href = `mailto:${email}?subject=${encodeURIComponent(subject)}`;
      else $("cs-email").removeAttribute("href");
      $("cs-email").hidden = !valid;
    }
    if ($("cs-email-text")) {
      $("cs-email-text").textContent = valid ? `이메일 ${email}` : "";
      $("cs-email-text").hidden = !valid;
    }
  }

  // ---------- 하단 (안내 탭 기반) ----------
  // 줄 구성 고정: [상호명 | 대표자] / [주소] / [사업자등록번호 | 통신판매업 신고번호 | 고객센터 | 이메일]
  //             / [영업시간] / [개인정보보호책임자 | 호스팅 제공자]
  // 값은 안내 탭에서 가져오고(항목 이름 띄어쓰기 무시), 비어 있는 항목·줄은 생략. 그 밖의 추가 항목은 마지막 줄
  const FOOTER_LINES = [
    ["상호명", "대표자"],
    ["주소"],
    ["사업자등록번호", "통신판매업 신고번호", "고객센터", "이메일"],
    ["영업시간"],
    ["개인정보보호책임자", "호스팅 제공자"],
  ];
  const FOOTER_ALIASES = { 상호명: ["상호명", "업체명"], 고객센터: ["고객센터", "연락처"] };
  const aliasesOf = (label) => FOOTER_ALIASES[normalizeKey(label)] || [normalizeKey(label)];
  // 고정 줄에서 쓰는 키(별칭 포함) + 상단·문의 버튼·화면 설정용 키는 추가 항목에서 제외
  const FOOTER_SKIP = new Set([
    "소개", "기준일", "카카오톡", "분류순서", "제철문구", "주문이메일", "고객센터운영시간", "이용약관", "개인정보처리방침",
    ...FOOTER_LINES.flat().flatMap(aliasesOf),
  ]);

  function renderFooter(info) {
    const lookup = new Map(Object.entries(info).map(([k, v]) => [normalizeKey(k), v]));
    const valueOf = (label) => aliasesOf(label).map((k) => lookup.get(k)).find(Boolean) || "";

    // 이용약관·개인정보처리방침: 하단 링크는 HTML 에 사이트 안 문서로 들어 있음 (안내 탭을 못 읽어도 표시)
    // 안내 탭에 다른 문서 주소를 적으면 그 주소로 바꿈
    for (const [key, id] of [["이용약관", "link-terms"], ["개인정보처리방침", "link-privacy"]]) {
      const href = safeUrl(lookup.get(key) || "");
      if (href && $(id)) $(id).href = href;
    }

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

  function renderNotices(rows, preview = NOTICE_PREVIEW) {
    const notices = rows
      .filter((r) => isVisible(r) && (get(r, "제목") || get(r, "내용")))
      .map((r, index) => ({ r, index }))
      .sort((a, b) =>
        isYes(get(b.r, "중요")) - isYes(get(a.r, "중요")) ||
        dateKey(get(b.r, "등록일")) - dateKey(get(a.r, "등록일")) ||
        a.index - b.index
      )
      .map(({ r }) => r);
    if (!notices.length) return 0;

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
      return el("li", { hidden: i >= preview }, el("details", { open: i === 0 }, [summary, body]));
    });

    $("notice-list").replaceChildren(...items);
    $("notices").hidden = false;

    const more = $("notice-more");
    if (notices.length > preview) {
      more.textContent = `이전 공지 ${notices.length - preview}건 더보기`;
      more.hidden = false;
      more.addEventListener("click", () => {
        items.forEach((li) => { li.hidden = false; });
        more.hidden = true;
      }, { once: true });
    }
    return notices.length;
  }

  // ---------- 상품 시트 ----------

  // 보관 방식 배지 (사진 위)
  function storageBadge(item) {
    const s = storageOf(item);
    return s ? el("span", { className: `badge storage ${STORAGE_CLASS[s] || "etc"}`, textContent: s }) : null;
  }

  // 추천·제철·당일출고 배지
  function tagBadges(item) {
    const tags = [
      [COL.rec, "추천", "rec"],
      [COL.season, "제철", "season"],
      [COL.sameDay, "당일출고", "sameday"],
    ].filter(([col]) => isYes(get(item, col)));
    return tags.length
      ? el("div", { className: "tags" }, tags.map(([, label, cls]) => el("span", { className: `badge tag ${cls}`, textContent: label })))
      : null;
  }

  // inModal: 상세 창 안에 그릴 때 (클릭 시 다시 창을 열지 않음)
  // compact: 주력·제철 상품 줄 — 보기 방식과 상관없이 누르면 상세 창
  function renderCard(item, { inModal = false, compact = false } = {}) {
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

    // 상세 창: 상품명을 복사해 두고 카카오톡 문의로 연결
    if (inModal && state.kakaoUrl && !soldOut) {
      const ask = el("a", {
        className: "kakao-ask", href: state.kakaoUrl, target: "_blank", rel: "noopener noreferrer",
        textContent: "이 상품 카톡으로 문의",
      });
      ask.addEventListener("click", () => copyForInquiry(get(item, COL.name)));
      links.append(ask);
    }

    const card = el("article", { className: "card" + (soldOut ? " sold-out" : "") }, [
      el("div", { className: "photo" }, [img, storageBadge(item)]),
      el("div", { className: "card-body" }, [
        el("div", { className: "card-head" }, [el("h3", { textContent: get(item, COL.name) || "(상품명 없음)" }), badge]),
        tagBadges(item),
        price,
        fields.childElementCount ? fields : null,
        notes ? el("p", { className: "notes", textContent: notes }) : null,
        links.childElementCount ? links : null,
      ]),
    ]);
    if (inModal) return card;
    card.dataset.name = get(item, COL.name);
    // 바둑판·주력/제철 줄: 카드를 누르면 상세 창 / 자세히: 이미 다 보이므로 최근 본 상품에만 기록
    const opensDetail = compact || state.view === "grid";
    card.addEventListener("click", () => {
      if (!opensDetail) return recordView(item);
      if (SUPPORTS_DIALOG) return openDetail(item);
      goToItem(get(item, COL.name)); // 상세 창이 안 되는 구형 브라우저: 목록의 카드로 이동
    });
    if (opensDetail) {
      // 키보드(Tab → Enter/Space)로도 상세 창을 열 수 있게
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `${get(item, COL.name)} 자세히 보기`);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); card.click(); }
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
    const find = () => [...document.querySelectorAll("#list .card")].find((c) => c.dataset.name === name);
    if (!find()) {
      state.category = ALL;
      state.storage = ALL;
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
    state.kakaoUrl = href;
    for (const id of ["fab-kakao", "cs-kakao", "drawer-kakao"]) {
      const a = $(id);
      if (!a) continue;
      a.href = href;
      a.hidden = false;
    }
  }

  // 카카오톡 채널 채팅은 메시지를 미리 채울 수 없어서, 상품명을 복사해 두고 붙여 넣게 안내
  function copyForInquiry(name) {
    const text = `[엄마수산 문의] ${name}`;
    const done = () => showToast("상품명을 복사했어요. 채팅창에 붙여 넣어 주세요.");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {});
    }
  }

  let toastTimer = null;
  function showToast(message) {
    const t = $("toast");
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
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
      btn.addEventListener("click", () => selectCategory(name, { scroll: false }));
      return btn;
    }));
    chips.hidden = categories().length <= 2;

    // 보관 방식 필터 (보관 열에 값이 있는 상품이 있을 때만)
    const storages = storageList();
    const sc = $("storage-chips");
    sc.replaceChildren(...(storages.length ? [ALL, ...storages] : []).map((name) => {
      const btn = el("button", { type: "button", className: name === ALL ? "" : `st ${STORAGE_CLASS[name] || "etc"}`, textContent: name === ALL ? "보관 전체" : name });
      btn.setAttribute("aria-pressed", String(name === state.storage));
      btn.addEventListener("click", () => selectStorage(name, { scroll: false }));
      return btn;
    }));
    sc.hidden = !storages.length;
    renderNav();
  }

  // 시트에 있는 보관 방식 (당일생물 → 냉장 → 냉동 → 상온 → 그 외)
  function storageList() {
    const seen = [...new Set(state.items.map(storageOf).filter(Boolean))];
    const rank = (s) => (STORAGE_ORDER.includes(s) ? STORAGE_ORDER.indexOf(s) : STORAGE_ORDER.length);
    return seen.sort((a, b) => rank(a) - rank(b));
  }

  function scrollToList() {
    const target = document.querySelector(".toolbar");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function selectCategory(name, { scroll = true } = {}) {
    state.category = name;
    setDrawerOpen(false);
    renderChips();
    renderList();
    if (scroll) scrollToList();
  }

  function selectStorage(name, { scroll = true } = {}) {
    state.storage = name;
    setDrawerOpen(false);
    renderChips();
    renderList();
    if (scroll) scrollToList();
  }

  // ---------- 상단 메뉴(PC) · 전체 메뉴(휴대폰) ----------

  function renderNav() {
    const cats = categories();
    const count = (c) => (c === ALL ? state.items.length : state.items.filter((i) => categoryOf(i) === c).length);
    const label = (c) => (c === ALL ? "전체상품" : c);

    const gnbCats = $("gnb-cats");
    if (gnbCats) {
      gnbCats.replaceChildren(...cats.map((c) => {
        const btn = el("button", { type: "button", textContent: label(c) });
        if (c === state.category) btn.setAttribute("aria-current", "true");
        btn.addEventListener("click", () => selectCategory(c));
        return btn;
      }));
    }

    const drawerCats = $("drawer-cats");
    if (drawerCats) {
      drawerCats.replaceChildren(...cats.map((c) => {
        const btn = el("button", { type: "button" }, [el("span", { textContent: label(c) }), el("small", { textContent: String(count(c)) })]);
        if (c === state.category) btn.setAttribute("aria-current", "true");
        btn.addEventListener("click", () => selectCategory(c));
        return el("li", {}, btn);
      }));
    }

    const storages = storageList();
    const drawerSt = $("drawer-storage");
    if (drawerSt) {
      drawerSt.replaceChildren(...storages.map((s) => {
        const btn = el("button", { type: "button", className: `badge storage ${STORAGE_CLASS[s] || "etc"}`, textContent: s });
        btn.setAttribute("aria-pressed", String(s === state.storage));
        btn.addEventListener("click", () => selectStorage(s === state.storage ? ALL : s));   // 다시 누르면 해제
        return btn;
      }));
      $("drawer-storage-group").hidden = !storages.length;
    }
  }

  function setDrawerOpen(open) {
    const d = $("drawer");
    if (!d) return;
    if (d.hidden === !open) return;
    d.hidden = !open;
    $("menu-open").setAttribute("aria-expanded", String(open));
    document.documentElement.classList.toggle("drawer-open", open);
    // 열려 있는 동안 뒤쪽 화면은 키보드·화면낭독기에서 제외
    for (const node of document.body.children) if (node !== d && node.tagName !== "SCRIPT") node.inert = open;
    (open ? $("drawer-close") : $("menu-open")).focus();
  }

  function initNav() {
    if (!$("drawer")) return;
    $("menu-open").addEventListener("click", () => setDrawerOpen(true));
    $("drawer-close").addEventListener("click", () => setDrawerOpen(false));
    $("drawer").addEventListener("click", (e) => { if (e.target === $("drawer")) setDrawerOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("drawer").hidden) setDrawerOpen(false); });
    const form = $("search-form");
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); $("search").blur(); scrollToList(); });
  }

  // ---------- 배너 (배너 탭: 이미지 | 링크 | 제목 | 노출) ----------

  function renderBanners(rows) {
    const box = $("banner");
    if (!box) return;
    const slides = rows
      .filter((r) => isVisible(r) && toImageUrl(get(r, "이미지")))
      .map((r) => {
        const img = el("img", { src: toImageUrl(get(r, "이미지"), 1600), alt: get(r, "제목") || "엄마수산 배너", referrerPolicy: "no-referrer", loading: "eager" });
        const href = safeUrl(get(r, "링크"));
        const slide = href
          ? el("a", { className: "slide", href, target: "_blank", rel: "noopener noreferrer" }, img)
          : el("div", { className: "slide" }, img);
        // 사진을 못 불러오면 그 배너만 빼기
        img.addEventListener("error", () => { slide.remove(); updateDots(); if (!track.children.length) box.hidden = true; }, { once: true });
        return slide;
      });
    if (!slides.length) return;
    const track = $("banner-track");
    const dots = $("banner-dots");
    track.replaceChildren(...slides);
    box.hidden = false;

    const current = () => Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const goTo = (k) => track.scrollTo({ left: k * track.clientWidth, behavior: "smooth" });

    // 점: 장 수가 바뀔 때만 새로 만들고, 넘길 때는 표시만 바꿈
    function updateDots() {
      const n = track.children.length;
      dots.hidden = n < 2;
      if (dots.children.length !== n) {
        dots.replaceChildren(...[...Array(n)].map((_, k) => {
          const dot = el("button", { type: "button" });
          dot.setAttribute("aria-label", `${k + 1}번째 배너`);
          dot.addEventListener("click", () => { pauseUntil = Date.now() + 8000; goTo(k); });
          return dot;
        }));
      }
      const i = current();
      [...dots.children].forEach((dot, k) => {
        dot.classList.toggle("on", k === i);
        if (k === i) dot.setAttribute("aria-current", "true"); else dot.removeAttribute("aria-current");
      });
    }
    let frame = 0;
    track.addEventListener("scroll", () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateDots(); });
    }, { passive: true });
    updateDots();

    let pauseUntil = 0;
    let hovering = false;   // 마우스를 올리거나 키보드로 들어와 있는 동안은 자동 넘김 멈춤
    for (const ev of ["pointerdown", "touchstart", "wheel"]) {
      track.addEventListener(ev, () => { pauseUntil = Date.now() + 8000; }, { passive: true });
    }
    box.addEventListener("mouseenter", () => { hovering = true; });
    box.addEventListener("mouseleave", () => { hovering = false; });
    box.addEventListener("focusin", () => { hovering = true; });
    box.addEventListener("focusout", () => { hovering = false; });
    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduceMotion) {
      setInterval(() => {
        const n = track.children.length;
        if (n < 2 || document.hidden || hovering || Date.now() < pauseUntil) return;
        goTo((current() + 1) % n);
      }, 5000);
    }
  }

  // ---------- 이달의 주력상품 · 제철 상품 ----------

  // 주력상품: 큰 카드 + 순위 리본 (적으면 상자에 맞게 늘리고, 많으면 가로 넘기기) / 제철: 가로형 타일 2열
  function renderShelves() {
    const pick = (col) => state.items.filter((i) => isYes(get(i, col)))
      .sort(withSoldOutLast((a, b) => state.rowIndex.get(a) - state.rowIndex.get(b)));
    const fill = (boxId, items, withRank) => {
      const box = $(boxId);
      if (!box) return;
      box.hidden = !items.length;
      const track = box.querySelector(".shelf-track, .season-grid");
      track.dataset.count = String(items.length);   // 개수에 따라 꽉 채움 / 가로 넘김 (style.css)
      track.replaceChildren(...items.map((item, k) => {
        if (!withRank) return renderTile(item);   // 제철: 가로형 타일
        const card = renderCard(item, { compact: true });
        if (withRank) card.querySelector(".photo").append(el("span", { className: "rank", textContent: String(k + 1) }));
        return card;
      }));
    };
    fill("shelf-rec", pick(COL.rec), true);
    fill("shelf-season", pick(COL.season), false);
    const m = $("season-month");
    if (m) m.textContent = `${new Date().getMonth() + 1}월 제철`;
  }

  // 제철 타일: 사진 왼쪽 + 이름·(PC: 원산지·규격·안내)·가격 오른쪽
  function renderTile(item) {
    const soldOut = isSoldOut(item);
    const imgSrc = toImageUrl(get(item, COL.photo), 400);
    const emptyPhoto = () => el("div", { className: "img-empty", textContent: "준비중" });
    const img = imgSrc
      ? el("img", { src: imgSrc, alt: get(item, COL.name), loading: "lazy", referrerPolicy: "no-referrer" })
      : emptyPhoto();
    if (imgSrc) img.addEventListener("error", () => img.replaceWith(emptyPhoto()), { once: true });

    const meta = [get(item, "원산지"), get(item, "규격 및 구성")].filter(Boolean).join(" · ");
    const tile = el("article", { className: "tile" + (soldOut ? " sold-out" : "") }, [
      el("div", { className: "photo" }, img),
      el("div", { className: "tile-body" }, [
        el("div", { className: "tile-top" }, [
          storageBadge(item),
          soldOut ? el("span", { className: "badge warn", textContent: get(item, COL.status) }) : null,
        ]),
        el("h3", { textContent: get(item, COL.name) || "(상품명 없음)" }),
        meta ? el("p", { className: "tile-meta", textContent: meta }) : null,
        get(item, COL.notes) ? el("p", { className: "tile-desc", textContent: get(item, COL.notes) }) : null,
        renderPrice(item),
      ]),
    ]);
    tile.dataset.name = get(item, COL.name);
    tile.tabIndex = 0;
    tile.setAttribute("role", "button");
    tile.setAttribute("aria-label", `${get(item, COL.name)} 자세히 보기`);
    tile.addEventListener("click", () => (SUPPORTS_DIALOG ? openDetail(item) : goToItem(get(item, COL.name))));
    tile.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tile.click(); } });
    return tile;
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
      (state.storage === ALL || storageOf(item) === state.storage) &&
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
    initNav();
    initFab();
    setKakao(CONFIG.kakaoUrl);
    if (PAGE === "order") return initOrderPage();
    if (PAGE === "notices") return initNoticesPage();
    if (PAGE === "legal") return initLegalPage();

    $("search").addEventListener("input", (e) => { state.query = e.target.value.trim(); renderList(); });
    $("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    for (const btn of document.querySelectorAll("[data-view]")) {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    }
    if (!SUPPORTS_DIALOG) document.querySelector(".view-toggle").hidden = true;
    setView(state.view);
    initDetail();

    // 안내·배너 탭은 없어도 상품은 표시된다 (공지는 공지사항 페이지에서)
    const onItemsRetry = (n) => { $("status").textContent = `연결이 원활하지 않아 다시 시도하는 중… (${n}/${FETCH_RETRIES})`; };
    const results = await Promise.allSettled([
      fetchCsv("items", onItemsRetry),
      fetchCsv("info"),
      fetchCsv("banners"),
    ]);
    const [items, info, banners] = [
      settle(results[0], "items"),
      settle(results[1], "info"),
      settle(results[2], "banners"),
    ];
    for (const r of [items, info, banners]) if (r.error) console.warn(r.error);

    if (info.rows) applyInfo(info.rows);
    if (banners.rows) renderBanners(banners.rows);

    if (!items.rows) {
      showLoadError($("status"), items.error);
      return;
    }

    // 사본으로 대신 보여주는 중이면 안내
    showStale($("stale"), [items, info]);

    state.items = items.rows.filter(isVisible);
    state.items.forEach((item, i) => state.rowIndex.set(item, i));
    renderShelves();
    renderChips();
    renderList();
    renderRecent();
  }

  function applyInfo(rows) {
    renderInfo(rows);
    if (!CONFIG.kakaoUrl) {
      const row = rows.find((r) => normalizeKey(get(r, "항목")) === "카카오톡");
      if (row) setKakao(get(row, "내용"));
    }
  }

  // ---------- 주문방법 페이지 (주문방법 탭: 제목 | 내용 | 구분) ----------
  // 구분이 "안내"인 행은 번호 없는 안내 상자, 나머지는 순서대로 번호 단계

  async function initOrderPage() {
    const [order, info] = (await Promise.allSettled([fetchCsv("order"), fetchCsv("info")]))
      .map((r, k) => settle(r, k === 0 ? "order" : "info"));
    if (info.rows) applyInfo(info.rows);

    if (!order.rows) {
      showLoadError($("order-status"), order.error);
      return;
    }
    const rows = order.rows.filter((r) => isVisible(r) && get(r, "제목"));
    if (!rows.length) {
      $("order-status").textContent = "주문 방법을 준비하고 있어요. 카카오톡으로 문의해 주세요.";
      return;
    }
    $("order-status").textContent = "";
    showStale($("order-status"), [order, info]);
    const isNote = (r) => normalizeKey(get(r, "구분")) === "안내";
    $("order-steps").replaceChildren(...rows.filter((r) => !isNote(r)).map((r) =>
      el("li", {}, el("div", {}, [el("strong", { textContent: get(r, "제목") }), get(r, "내용") ? el("p", { textContent: get(r, "내용") }) : null]))
    ));
    $("order-notes").replaceChildren(...rows.filter(isNote).map((r) =>
      el("div", { className: "order-note" }, [el("h3", { textContent: get(r, "제목") }), el("p", { textContent: get(r, "내용") })])
    ));
  }

  // 약관 페이지: 본문은 고정 글, 하단 정보·카카오 버튼만 시트에서
  async function initLegalPage() {
    const info = settle((await Promise.allSettled([fetchCsv("info")]))[0], "info");
    if (info.rows) applyInfo(info.rows);
  }

  async function initNoticesPage() {
    const [notices, info] = (await Promise.allSettled([fetchCsv("notices"), fetchCsv("info")]))
      .map((r, k) => settle(r, k === 0 ? "notices" : "info"));
    if (info.rows) applyInfo(info.rows);
    if (!notices.rows) {
      showLoadError($("notice-status"), notices.error);
      return;
    }
    const count = renderNotices(notices.rows, 10);
    $("notice-status").textContent = count ? "" : "등록된 공지가 없습니다.";
    if (count) showStale($("notice-status"), [notices, info]);
  }

  init();
})();
