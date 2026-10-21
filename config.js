// 엄마수산 — 사이트 설정
// 관리자는 구글 시트만 수정하면 되고, 이 파일은 최초 1회만 설정한다.
window.APP_CONFIG = {
  // 구글 시트 주소 https://docs.google.com/spreadsheets/d/{여기}/edit 의 {여기} 부분
  // 비워두면 sample/ 폴더의 샘플 데이터로 표시된다.
  sheetId: "1RusBrTaPuwYs0YazkbhnyjW87SwHwftmqcbJFZKvIUg",

  // 시트 하단 탭 이름
  itemsSheet: "상품게시",
  noticeSheet: "공지사항",
  infoSheet: "안내", // 선택 탭 (업체명·소개·연락처 등). 없어도 동작

  // 우측 하단 "카카오톡 문의" 버튼 주소 (카카오톡 채널 채팅 주소 등).
  // 비워두면 안내 탭의 "카카오톡" 항목을 쓰고, 그것도 없으면 버튼을 숨긴다.
  kakaoUrl: "",
};
