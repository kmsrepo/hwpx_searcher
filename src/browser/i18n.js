const I18n = (() => {
  const dictionaries = {
    en: {
      "app.aria": "HWP search application",
      "app.title": "HWP Search",
      "app.subtitle": "HWP/HWPX content search",
      "theme.aria": "Theme",
      "theme.system": "Theme: System",
      "theme.light": "Theme: Light",
      "theme.dark": "Theme: Dark",
      "language.aria": "Language",
      "language.en": "English",
      "language.ko": "Korean",
      "search.aria": "Search controls",
      "search.placeholder": "Search text",
      "search.label": "Search text",
      "search.button": "Search",
      "search.cancel": "Cancel",
      "search.caseSensitive": "Case sensitive",
      "panel.index": "Index",
      "panel.options": "Options",
      "panel.status": "Status",
      "panel.results": "Results",
      "index.chooseFolder": "Choose folder",
      "index.noFolder": "No folder",
      "index.noHwpFiles": "No HWP/HWPX files",
      "index.dropFailed": "Drop failed",
      "index.dropToIndex": "Drop to index",
      "option.groupLevel": "Group level",
      "option.groupLevelAria": "Default result group level",
      "option.fileGroups": "File groups",
      "option.pageGroups": "Page groups",
      "option.detailRows": "Detail rows",
      "option.workers": "Workers",
      "option.workerCountAria": "Worker count",
      "sort.path": "Path",
      "sort.filename": "Filename",
      "sort.modified": "Modified date",
      "sort.modifiedShort": "Modified",
      "sort.size": "File size",
      "sort.sizeShort": "Size",
      "sort.type": "File type",
      "sort.asc": "Asc",
      "sort.desc": "Desc",
      "metric.aria": "Search metrics",
      "metric.queued": "Queued",
      "metric.scanned": "Scanned",
      "metric.matches": "Matches",
      "metric.workers": "Workers",
      "metric.errors": "Errors",
      "errors.details": "Error details",
      "errors.path": "Path",
      "errors.message": "Message",
      "summary.idle": "Idle",
      "summary.queued": "{count} queued",
      "summary.chooseFolder": "Choose a folder first",
      "summary.search": "{matches} matches · {files} files{errors}",
      "summary.errors": " · {count} errors",
      "summary.progress": "{scanned} / {total}",
      "status.loading": "Loading",
      "status.ready": "Ready",
      "status.error": "Error",
      "status.searching": "Searching",
      "status.indexing": "Indexing",
      "status.preview": "Preview",
      "result.page": "page {page}",
      "result.matchCount": "{count} match",
      "result.matchCount_plural": "{count} matches",
      "result.showDetails": "click to show details",
      "result.openDocument": "click a detail to open document",
      "result.limitedDetails": "Showing {shown} of {total} details to keep results responsive.",
      "result.openPagePreview": "Open page preview",
      "result.localFormat": "{format} · local",
      "worker.auto": "Workers: Auto (~50% CPU)",
      "worker.count": "{count} worker",
      "worker.count_plural": "{count} workers",
      "preview.title": "Preview",
      "preview.close": "Close preview",
      "preview.pageTitle": "{label} · page {page} of {pages}",
    },
    ko: {
      "app.aria": "HWP 검색 애플리케이션",
      "app.title": "HWP 검색",
      "app.subtitle": "HWP/HWPX 본문 검색",
      "theme.aria": "테마",
      "theme.system": "테마: 시스템",
      "theme.light": "테마: 라이트",
      "theme.dark": "테마: 다크",
      "language.aria": "언어",
      "language.en": "영어",
      "language.ko": "한국어",
      "search.aria": "검색 컨트롤",
      "search.placeholder": "검색어",
      "search.label": "검색어",
      "search.button": "검색",
      "search.cancel": "취소",
      "search.caseSensitive": "대소문자 구분",
      "panel.index": "색인",
      "panel.options": "옵션",
      "panel.status": "상태",
      "panel.results": "결과",
      "index.chooseFolder": "폴더 선택",
      "index.noFolder": "폴더 없음",
      "index.noHwpFiles": "HWP/HWPX 파일 없음",
      "index.dropFailed": "드롭 실패",
      "index.dropToIndex": "색인할 파일 놓기",
      "option.groupLevel": "그룹 단계",
      "option.groupLevelAria": "기본 결과 그룹 단계",
      "option.fileGroups": "파일 그룹",
      "option.pageGroups": "페이지 그룹",
      "option.detailRows": "상세 행",
      "option.workers": "작업자",
      "option.workerCountAria": "작업자 수",
      "sort.path": "경로",
      "sort.filename": "파일명",
      "sort.modified": "수정일",
      "sort.modifiedShort": "수정일",
      "sort.size": "파일 크기",
      "sort.sizeShort": "크기",
      "sort.type": "파일 형식",
      "sort.asc": "오름차순",
      "sort.desc": "내림차순",
      "metric.aria": "검색 지표",
      "metric.queued": "대기",
      "metric.scanned": "스캔됨",
      "metric.matches": "일치",
      "metric.workers": "작업자",
      "metric.errors": "오류",
      "errors.details": "오류 상세",
      "errors.path": "경로",
      "errors.message": "메시지",
      "summary.idle": "대기 중",
      "summary.queued": "{count}개 대기",
      "summary.chooseFolder": "먼저 폴더를 선택하세요",
      "summary.search": "{matches}개 일치 · {files}개 파일{errors}",
      "summary.errors": " · 오류 {count}개",
      "summary.progress": "{scanned} / {total}",
      "status.loading": "로딩 중",
      "status.ready": "준비됨",
      "status.error": "오류",
      "status.searching": "검색 중",
      "status.indexing": "색인 중",
      "status.preview": "미리보기",
      "result.page": "{page}페이지",
      "result.matchCount": "{count}개 일치",
      "result.matchCount_plural": "{count}개 일치",
      "result.showDetails": "클릭하여 상세 보기",
      "result.openDocument": "상세를 클릭하여 문서 열기",
      "result.limitedDetails": "결과 응답성을 위해 {total}개 중 {shown}개 상세만 표시합니다.",
      "result.openPagePreview": "페이지 미리보기 열기",
      "result.localFormat": "{format} · 로컬",
      "worker.auto": "작업자: 자동(CPU 약 50%)",
      "worker.count": "작업자 {count}개",
      "worker.count_plural": "작업자 {count}개",
      "preview.title": "미리보기",
      "preview.close": "미리보기 닫기",
      "preview.pageTitle": "{label} · {page} / {pages}페이지",
    },
  };
  let language = "en";

  function setLanguage(nextLanguage) {
    language = normalizeLanguage(nextLanguage);
    document.documentElement.lang = language;
    return language;
  }

  function getLanguage() {
    return language;
  }

  function normalizeLanguage(value) {
    return Object.prototype.hasOwnProperty.call(dictionaries, value) ? value : "en";
  }

  function t(key, params = {}) {
    const dictionary = dictionaries[language] || dictionaries.en;
    const pluralKey = params.count !== 1 ? key + "_plural" : key;
    const template = dictionary[pluralKey] || dictionary[key] || dictionaries.en[pluralKey] || dictionaries.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
  }

  function translateDocument(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
      element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
    });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    });
    document.title = t("app.title");
  }

  return {
    getLanguage,
    normalizeLanguage,
    setLanguage,
    t,
    translateDocument,
  };
})();
