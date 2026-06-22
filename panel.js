const MAX_HISTORY = 500;
const FILTER_EXTENSIONS = [
  "js",
  "gif",
  "jpg",
  "png",
  "ico",
  "css",
  "woff",
  "woff2",
  "ttf",
  "svg",
  "asp",
  "aspx",
  "jsp",
  "php",
  "html"
];
const DEFAULT_HIDDEN_EXTENSIONS = new Set([
  "js",
  "gif",
  "jpg",
  "png",
  "ico",
  "css",
  "woff",
  "woff2",
  "ttf",
  "svg"
]);
const DEFAULT_HISTORY_COLUMNS = {
  sequenceId: 56,
  method: 72,
  status: 64,
  url: 360,
  timestamp: 74
};
const MIN_HISTORY_COLUMNS = {
  sequenceId: 44,
  method: 58,
  status: 54,
  url: 180,
  timestamp: 64
};

const state = {
  inspectedTabId: chrome.devtools.inspectedWindow.tabId,
  capturing: true,
  mode: "capturing",
  entries: [],
  selectedId: null,
  activeView: "detail",
  repeaterTabs: [],
  activeRepeaterId: null,
  nextSequenceId: 1,
  sort: {
    key: "sequenceId",
    direction: "desc"
  },
  hiddenExtensions: new Set(DEFAULT_HIDDEN_EXTENSIONS),
  highlightTargetId: null,
  historyPaneSize: null,
  detailRequestPaneSize: null,
  historyColumns: { ...DEFAULT_HISTORY_COLUMNS },
  urlMenuTargetId: null,
  blockedUrls: new Set(),
  interceptUrls: new Set(),
  interceptEnabled: false,
  interceptPollId: null,
  pausedInterceptId: null,
  interceptMenuTargetUrl: null,
  editorMenuTarget: null,
  theme: "dark"
};

const findState = {
  editor: null,
  bar: null,
  input: null,
  count: null,
  matches: [],
  index: -1
};

const els = {
  modeSelect: document.querySelector("#modeSelect"),
  themeToggle: document.querySelector("#themeToggle"),
  downloadProject: document.querySelector("#downloadProject"),
  uploadProject: document.querySelector("#uploadProject"),
  projectFile: document.querySelector("#projectFile"),
  toggleCapture: document.querySelector("#toggleCapture"),
  clearHistory: document.querySelector("#clearHistory"),
  searchInput: document.querySelector("#searchInput"),
  extensionFilterList: document.querySelector("#extensionFilterList"),
  historyTable: document.querySelector("#historyTable"),
  interceptListPane: document.querySelector("#interceptListPane"),
  interceptUrlList: document.querySelector("#interceptUrlList"),
  requestList: document.querySelector("#requestList"),
  historySortButtons: Array.from(document.querySelectorAll(".history-sort")),
  columnResizers: Array.from(document.querySelectorAll(".column-resizer")),
  highlightMenu: document.querySelector("#highlightMenu"),
  urlMenu: document.querySelector("#urlMenu"),
  interceptUrlMenu: document.querySelector("#interceptUrlMenu"),
  editorMenu: document.querySelector("#editorMenu"),
  decodeDialog: document.querySelector("#decodeDialog"),
  decodeTitle: document.querySelector("#decodeTitle"),
  decodeOutput: document.querySelector("#decodeOutput"),
  closeDecodeDialog: document.querySelector("#closeDecodeDialog"),
  copyDecodedText: document.querySelector("#copyDecodedText"),
  urlInterceptAction: document.querySelector("#urlInterceptAction"),
  urlBlockAction: document.querySelector("#urlBlockAction"),
  workspace: document.querySelector(".workspace"),
  workspaceResizeHandle: document.querySelector("#workspaceResizeHandle"),
  detailSplit: document.querySelector("#detailSplit"),
  detailResizeHandle: document.querySelector("#detailResizeHandle"),
  requestText: document.querySelector("#requestText"),
  responseText: document.querySelector("#responseText"),
  responseMeta: document.querySelector("#responseMeta"),
  sendToRepeater: document.querySelector("#sendToRepeater"),
  repeaterTabList: document.querySelector("#repeaterTabList"),
  emptyRepeater: document.querySelector("#emptyRepeater"),
  repeaterEditors: document.querySelector("#repeaterEditors"),
  repeaterResizeHandle: document.querySelector("#repeaterResizeHandle"),
  repeaterRequest: document.querySelector("#repeaterRequest"),
  repeaterResponse: document.querySelector("#repeaterResponse"),
  repeaterMeta: document.querySelector("#repeaterMeta"),
  sendRequest: document.querySelector("#sendRequest"),
  interceptStatus: document.querySelector("#interceptStatus"),
  interceptToggle: document.querySelector("#interceptToggle"),
  interceptRequest: document.querySelector("#interceptRequest"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  views: {
    detail: document.querySelector("#detailView"),
    repeater: document.querySelector("#repeaterView"),
    intercept: document.querySelector("#interceptView")
  }
};

els.rawEditors = [
  els.requestText,
  els.responseText,
  els.repeaterRequest,
  els.repeaterResponse,
  els.interceptRequest
];

chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  if (!state.capturing) {
    return;
  }

  harEntry.getContent((content, encoding) => {
    const entry = normalizeHarEntry(harEntry, content, encoding);
    entry.sequenceId = state.nextSequenceId;
    state.nextSequenceId += 1;
    state.entries.unshift(entry);
    state.entries = state.entries.slice(0, MAX_HISTORY);

    if (!state.selectedId) {
      state.selectedId = entry.id;
      renderDetail();
    }

    renderHistory();
  });
});

els.toggleCapture.addEventListener("click", () => {
  if (state.mode === "intercept") {
    setMode("capturing");
    return;
  }
  state.capturing = !state.capturing;
  renderCaptureToggle();
});

els.modeSelect.addEventListener("change", () => {
  setMode(els.modeSelect.value);
});

els.themeToggle.addEventListener("click", () => {
  setTheme(state.theme === "light" ? "dark" : "light", true);
});

els.clearHistory.addEventListener("click", () => {
  state.entries = [];
  state.selectedId = null;
  state.nextSequenceId = 1;
  renderHistory();
  renderDetail();
});

els.searchInput.addEventListener("input", renderHistory);

for (const button of els.historySortButtons) {
  button.addEventListener("click", () => {
    setHistorySort(button.dataset.sort);
  });
}

for (const handle of els.columnResizers) {
  handle.addEventListener("pointerdown", startColumnResize);
  handle.addEventListener("click", (event) => event.stopPropagation());
}

els.highlightMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-color]");
  if (!button || !state.highlightTargetId) {
    return;
  }

  const entry = state.entries.find((candidate) => candidate.id === state.highlightTargetId);
  if (entry) {
    entry.highlight = button.dataset.color;
    renderHistory();
  }
  hideHighlightMenu();
});

els.urlMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.urlMenuTargetId) {
    return;
  }

  const entry = state.entries.find((candidate) => candidate.id === state.urlMenuTargetId);
  if (!entry) {
    hideUrlMenu();
    return;
  }

  if (button.dataset.action === "copy") {
    await copyText(entry.request.url);
  } else if (button.dataset.action === "delete") {
    deleteHistoryEntry(entry.id);
  } else if (button.dataset.action === "repeater") {
    sendEntryToRepeater(entry);
  } else if (button.dataset.action === "filter") {
    addHistoryFilter(entry.request.url, false);
  } else if (button.dataset.action === "exclude") {
    addHistoryFilter(entry.request.url, true);
  } else if (button.dataset.action === "intercept" || button.dataset.action === "unintercept") {
    await toggleHistoryEntryUrlIntercept(entry.request.url);
  } else if (button.dataset.action === "block" || button.dataset.action === "unblock") {
    await toggleHistoryEntryUrlBlock(entry.request.url);
  }

  hideUrlMenu();
});

els.interceptUrlMenu.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.dataset.action !== "remove" || !state.interceptMenuTargetUrl) {
    return;
  }

  await removeInterceptUrl(state.interceptMenuTargetUrl);
  hideInterceptUrlMenu();
});

els.editorMenu.addEventListener("click", handleEditorMenuClick);
els.closeDecodeDialog.addEventListener("click", hideDecodeDialog);
els.copyDecodedText.addEventListener("click", async () => {
  await copyText(els.decodeOutput.value);
});

document.addEventListener("click", () => {
  hideTransientMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideTransientMenus();
    hideDecodeDialog();
  }
});
document.addEventListener("keydown", handleEditorFindShortcut, true);

els.downloadProject.addEventListener("click", downloadProject);

els.uploadProject.addEventListener("click", () => {
  els.projectFile.click();
});

els.projectFile.addEventListener("change", uploadProject);

els.sendToRepeater.addEventListener("click", () => {
  const entry = selectedEntry();
  if (!entry) {
    return;
  }
  sendEntryToRepeater(entry);
});

els.sendRequest.addEventListener("click", sendActiveRepeaterRequest);

async function sendActiveRepeaterRequest() {
  const tab = activeRepeaterTab();
  if (!tab) {
    return;
  }

  syncActiveRepeaterTab();
  els.repeaterMeta.textContent = "Sending...";
  els.repeaterResponse.value = "";
  tab.meta = "Sending...";
  tab.responseText = "";

  try {
    const parsed = parseRawRequest(tab.requestText);
    const result = await sendRepeaterRequest(parsed);
    const skipped = result.response.skippedHeaders?.length
      ? ` | skipped: ${result.response.skippedHeaders.join(", ")}`
      : "";
    tab.meta = `${result.response.status} ${result.response.statusText} | ${result.response.durationMs} ms | ${result.transport}${skipped}`;
    tab.responseText = formatRawResponse(result.response);
    tab.updatedAt = new Date().toISOString();
  } catch (error) {
    tab.meta = "Error";
    tab.responseText = error.message || String(error);
  }

  renderRepeaterEditors();
}

els.interceptToggle.addEventListener("click", async () => {
  await setInterceptEnabled(!state.interceptEnabled);
});

els.repeaterRequest.addEventListener("input", syncActiveRepeaterTab);
els.interceptRequest.addEventListener("input", () => updateEditorHighlight(els.interceptRequest));

for (const editor of els.rawEditors) {
  editor.addEventListener("input", () => updateEditorHighlight(editor));
  editor.addEventListener("scroll", () => syncEditorScroll(editor));
  editor.addEventListener("contextmenu", showEditorContextMenu);
}

els.repeaterResizeHandle.addEventListener("pointerdown", startRepeaterResize);
els.repeaterResizeHandle.addEventListener("keydown", resizeRepeaterWithKeyboard);
els.workspaceResizeHandle.addEventListener("pointerdown", startWorkspaceResize);
els.workspaceResizeHandle.addEventListener("keydown", resizeWorkspaceWithKeyboard);
els.detailResizeHandle.addEventListener("pointerdown", startDetailResize);
els.detailResizeHandle.addEventListener("keydown", resizeDetailWithKeyboard);

for (const tab of els.tabs) {
  tab.addEventListener("click", () => {
    if (state.mode === "intercept") {
      if (tab.dataset.view === "detail") {
        forwardCurrentIntercept();
      } else {
        dropCurrentIntercept();
      }
      return;
    }
    switchView(tab.dataset.view);
  });
}

async function setMode(mode) {
  state.mode = mode;
  document.querySelector(".app").classList.toggle("intercept-mode", mode === "intercept");
  els.modeSelect.value = mode;
  state.capturing = mode === "capturing" || mode === "intercept";
  renderCaptureToggle();
  renderModeLayout();

  if (mode === "intercept") {
    await startInterceptMode();
    switchView("intercept");
    return;
  }

  await stopInterceptMode();
  if (state.activeView === "intercept") {
    switchView("detail");
  }
}

function setTheme(theme, persist = false) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  els.themeToggle.classList.toggle("light", state.theme === "light");
  els.themeToggle.title = state.theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  els.themeToggle.setAttribute("aria-label", els.themeToggle.title);

  if (persist) {
    chrome.storage.local.set({ interceptorTheme: state.theme }).catch(() => {});
  }
}

function renderCaptureToggle() {
  els.toggleCapture.classList.toggle("pause", state.capturing);
  els.toggleCapture.classList.toggle("play", !state.capturing);
  els.toggleCapture.title = state.capturing ? "Pause capture" : "Resume capture";
  els.toggleCapture.setAttribute("aria-label", els.toggleCapture.title);
}

async function restoreTheme() {
  const stored = await chrome.storage.local.get("interceptorTheme").catch(() => ({}));
  setTheme(stored.interceptorTheme || "dark");
}

async function startInterceptMode() {
  clearInterceptEditor("Waiting for request");
  await sendRuntimeMessage({
    type: "intercept:start",
    tabId: state.inspectedTabId,
    urls: Array.from(state.interceptUrls),
    enabled: state.interceptEnabled
  });

  if (state.interceptPollId) {
    window.clearInterval(state.interceptPollId);
  }
  state.interceptPollId = window.setInterval(pollIntercept, 500);
  await pollIntercept();
}

function renderModeLayout() {
  const interceptMode = state.mode === "intercept";
  document.querySelector(".filters").hidden = interceptMode;
  els.historyTable.hidden = interceptMode;
  els.interceptListPane.hidden = !interceptMode;
  els.interceptToggle.hidden = !interceptMode;

  els.tabs[0].textContent = interceptMode ? "Forward" : "History";
  els.tabs[1].textContent = interceptMode ? "Drop" : "Repeater";

  if (interceptMode) {
    for (const tab of els.tabs) {
      tab.classList.remove("active");
    }
  } else {
    for (const tab of els.tabs) {
      tab.classList.toggle("active", tab.dataset.view === state.activeView);
    }
  }
  renderInterceptUrlList();
  renderInterceptToggle();
}

async function stopInterceptMode() {
  if (state.interceptPollId) {
    window.clearInterval(state.interceptPollId);
    state.interceptPollId = null;
  }
  state.pausedInterceptId = null;
  await sendRuntimeMessage({ type: "intercept:stop", tabId: state.inspectedTabId }).catch(() => {});
}

async function pollIntercept() {
  if (!state.interceptEnabled) {
    els.interceptStatus.textContent = "Intercept disabled";
    return;
  }

  const result = await sendRuntimeMessage({ type: "intercept:getPaused", tabId: state.inspectedTabId }).catch((error) => {
    els.interceptStatus.textContent = error.message || String(error);
    return null;
  });

  if (!result?.paused) {
    if (!state.pausedInterceptId) {
      els.interceptStatus.textContent = "Waiting for request";
    }
    return;
  }

  if (result.paused.id === state.pausedInterceptId) {
    return;
  }

  state.pausedInterceptId = result.paused.id;
  const stage = result.paused.stage === "response" ? "Response" : "Request";
  els.interceptStatus.textContent = `${stage}: ${result.paused.method} ${result.paused.url}`;
  els.interceptRequest.value = result.paused.rawMessage;
  updateEditorHighlight(els.interceptRequest);
}

async function setInterceptEnabled(enabled) {
  state.interceptEnabled = enabled;
  renderInterceptToggle();
  if (!enabled) {
    clearInterceptEditor("Intercept disabled");
  } else {
    clearInterceptEditor("Waiting for request");
  }

  if (state.mode === "intercept") {
    await sendRuntimeMessage({
      type: "intercept:setEnabled",
      tabId: state.inspectedTabId,
      enabled
    }).catch((error) => {
      els.interceptStatus.textContent = error.message || String(error);
    });
  }
}

function renderInterceptToggle() {
  els.interceptToggle.textContent = state.interceptEnabled ? "Enabled" : "Disabled";
  els.interceptToggle.classList.toggle("enabled", state.interceptEnabled);
  els.interceptToggle.classList.toggle("disabled", !state.interceptEnabled);
}

function normalizeHarEntry(harEntry, content, encoding) {
  const requestHeaders = headersToObject(harEntry.request.headers);
  const responseHeaders = headersToObject(harEntry.response.headers);

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sequenceId: 0,
    startedDateTime: harEntry.startedDateTime,
    time: Math.round(harEntry.time || 0),
    request: {
      method: harEntry.request.method,
      url: harEntry.request.url,
      httpVersion: harEntry.request.httpVersion || "HTTP/1.1",
      headers: requestHeaders,
      body: harEntry.request.postData?.text || ""
    },
    response: {
      status: harEntry.response.status,
      statusText: harEntry.response.statusText,
      httpVersion: harEntry.response.httpVersion || "HTTP/1.1",
      headers: responseHeaders,
      body: content || "",
      encoding: encoding || ""
    }
  };
}

function headersToObject(headers) {
  const result = {};
  for (const header of headers || []) {
    if (isPseudoHeader(header.name)) {
      continue;
    }
    result[header.name] = header.value;
  }
  return result;
}

function renderHistory() {
  const filter = parseHistoryFilter(els.searchInput.value);
  const visibleEntries = state.entries.filter((entry) => {
    const haystack = [
      entry.sequenceId,
      entry.request.method,
      entry.response.status,
      entry.request.url,
      formatHistoryTime(entry.startedDateTime)
    ].join(" ").toLowerCase();
    return matchesHistoryFilter(haystack, filter) && !isHiddenByExtension(entry);
  }).sort(compareHistoryEntries);

  updateHistorySortButtons();
  applyHistoryColumnSizes();

  els.requestList.replaceChildren(...visibleEntries.map((entry) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = historyRowClass(entry);
    button.addEventListener("click", () => {
      state.selectedId = entry.id;
      renderHistory();
      renderDetail();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (event.target.classList.contains("url")) {
        state.urlMenuTargetId = entry.id;
        showUrlMenu(event.clientX, event.clientY);
      } else {
        state.highlightTargetId = entry.id;
        showHighlightMenu(event.clientX, event.clientY);
      }
    });

    const sequence = document.createElement("span");
    sequence.textContent = entry.sequenceId || "-";

    const method = document.createElement("span");
    method.className = "method";
    method.textContent = entry.request.method;

    const status = document.createElement("span");
    status.className = `status${entry.response.status >= 400 ? " error" : ""}`;
    status.textContent = entry.response.status || "-";

    const url = document.createElement("span");
    url.className = historyUrlClass(entry.request.url);
    url.title = entry.request.url;
    url.textContent = entry.request.url;

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = formatHistoryTime(entry.startedDateTime);

    button.append(sequence, method, status, url, time);
    item.append(button);
    return item;
  }));
}

function parseHistoryFilter(value) {
  const groups = [];
  let current = createHistoryFilterGroup();

  for (const token of tokenizeHistoryFilter(value)) {
    if (!token.negated && token.value === "or") {
      pushHistoryFilterGroup(groups, current);
      current = createHistoryFilterGroup();
      continue;
    }

    if (!token.negated && token.value === "and") {
      continue;
    }

    if (token.negated) {
      current.exclude.push(token.value);
    } else {
      current.include.push(token.value);
    }
  }

  pushHistoryFilterGroup(groups, current);
  return { groups };
}

function matchesHistoryFilter(haystack, filter) {
  if (!filter.groups.length) {
    return true;
  }

  return filter.groups.some((group) => {
    return group.include.every((term) => haystack.includes(term))
      && group.exclude.every((term) => !haystack.includes(term));
  });
}

function tokenizeHistoryFilter(value) {
  const tokens = [];
  const pattern = /\s*(!)?(?:'([^']*)'|"([^"]*)"|([^&\s]+))/g;
  let match;

  while ((match = pattern.exec(value || ""))) {
    const negated = Boolean(match[1]);
    const rawTerm = (match[2] || match[3] || match[4] || "").trim();
    const value = rawTerm.toLowerCase();
    if (value) {
      tokens.push({ value, negated });
    }
  }

  return tokens;
}

function createHistoryFilterGroup() {
  return {
    include: [],
    exclude: []
  };
}

function pushHistoryFilterGroup(groups, group) {
  if (group.include.length || group.exclude.length) {
    groups.push(group);
  }
}

function addHistoryFilter(value, excluded) {
  const token = excluded ? `!'${value}'` : `'${value}'`;
  const current = els.searchInput.value.trim();
  els.searchInput.value = current ? `${current} ${token}` : token;
  renderHistory();
}

function renderExtensionFilters() {
  const title = document.createElement("div");
  title.className = "extension-filter-title";
  title.textContent = "Show in history";

  const hint = document.createElement("div");
  hint.className = "extension-filter-hint";
  hint.textContent = "Checked extensions are visible.";

  const options = document.createElement("div");
  options.className = "extension-filter-options";

  options.replaceChildren(...FILTER_EXTENSIONS.map((extension) => {
    const label = document.createElement("label");
    label.className = "extension-filter-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !state.hiddenExtensions.has(extension);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.hiddenExtensions.delete(extension);
      } else {
        state.hiddenExtensions.add(extension);
      }
      renderHistory();
    });

    const text = document.createElement("span");
    text.textContent = `.${extension}`;

    label.append(checkbox, text);
    return label;
  }));

  els.extensionFilterList.replaceChildren(title, hint, options);
}

function applyHistoryColumnSizes() {
  let totalWidth = 32;
  for (const [name, width] of Object.entries(state.historyColumns)) {
    const safeWidth = Math.max(MIN_HISTORY_COLUMNS[name] || 40, Number(width) || DEFAULT_HISTORY_COLUMNS[name]);
    els.historyTable.style.setProperty(`--history-col-${name}`, `${safeWidth}px`);
    totalWidth += safeWidth;
  }
  els.historyTable.style.setProperty("--history-table-width", `${totalWidth}px`);
}

function startColumnResize(event) {
  const column = event.currentTarget.dataset.column;
  if (!column) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.setPointerCapture(event.pointerId);

  const startX = event.clientX;
  const startWidth = state.historyColumns[column] || DEFAULT_HISTORY_COLUMNS[column];
  const minWidth = MIN_HISTORY_COLUMNS[column] || 40;

  const onPointerMove = (moveEvent) => {
    const nextWidth = Math.max(minWidth, Math.round(startWidth + moveEvent.clientX - startX));
    state.historyColumns[column] = nextWidth;
    applyHistoryColumnSizes();
  };
  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp, { once: true });
}

function setHistorySort(key) {
  if (state.sort.key === key) {
    state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
  } else {
    state.sort.key = key;
    state.sort.direction = "asc";
  }
  renderHistory();
}

function compareHistoryEntries(left, right) {
  const direction = state.sort.direction === "asc" ? 1 : -1;
  const leftValue = historySortValue(left, state.sort.key);
  const rightValue = historySortValue(right, state.sort.key);

  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return (leftValue - rightValue) * direction;
  }
  return String(leftValue).localeCompare(String(rightValue)) * direction;
}

function historySortValue(entry, key) {
  if (key === "sequenceId") {
    return entry.sequenceId || 0;
  }
  if (key === "method") {
    return entry.request.method || "";
  }
  if (key === "status") {
    return entry.response.status || 0;
  }
  if (key === "url") {
    return entry.request.url || "";
  }
  if (key === "timestamp") {
    return Date.parse(entry.startedDateTime) || 0;
  }
  return "";
}

function updateHistorySortButtons() {
  for (const button of els.historySortButtons) {
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle("active", active);
    const label = button.textContent.replace(/\s+[↑↓]$/, "");
    button.textContent = active
      ? `${label} ${state.sort.direction === "asc" ? "↑" : "↓"}`
      : label;
  }
}

function historyRowClass(entry) {
  const classes = ["request-row"];
  if (entry.id === state.selectedId) {
    classes.push("active");
  }
  if (entry.highlight) {
    classes.push(`highlight-${entry.highlight}`);
  }
  return classes.join(" ");
}

function historyUrlClass(url) {
  const classes = ["url"];
  if (state.blockedUrls.has(url)) {
    classes.push("blocked-url");
  }
  if (state.interceptUrls.has(url)) {
    classes.push("intercepted-url");
  }
  return classes.join(" ");
}

function showHighlightMenu(clientX, clientY) {
  showPositionedMenu(els.highlightMenu, clientX, clientY);
}

function hideHighlightMenu() {
  els.highlightMenu.hidden = true;
  state.highlightTargetId = null;
}

function showUrlMenu(clientX, clientY) {
  const entry = state.entries.find((candidate) => candidate.id === state.urlMenuTargetId);
  const blocked = entry ? state.blockedUrls.has(entry.request.url) : false;
  const intercepted = entry ? state.interceptUrls.has(entry.request.url) : false;
  els.urlInterceptAction.dataset.action = intercepted ? "unintercept" : "intercept";
  els.urlInterceptAction.textContent = intercepted ? "Remove Intercept" : "Intercept";
  els.urlBlockAction.dataset.action = blocked ? "unblock" : "block";
  els.urlBlockAction.textContent = blocked ? "Unblock" : "Block";

  showPositionedMenu(els.urlMenu, clientX, clientY);
}

function hideUrlMenu() {
  els.urlMenu.hidden = true;
  state.urlMenuTargetId = null;
}

function showEditorContextMenu(event) {
  const editor = event.currentTarget;
  const kind = editorKind(editor);
  if (!kind) {
    return;
  }

  event.preventDefault();
  hideTransientMenus();

  const hasSelection = editor.selectionStart !== editor.selectionEnd;
  state.editorMenuTarget = { editor, kind, hasSelection };
  renderEditorMenu(kind, hasSelection, editor.readOnly);
  showPositionedMenu(els.editorMenu, event.clientX, event.clientY);
  updateEditorSubmenuDirection();
}

function renderEditorMenu(kind, hasSelection, readOnly) {
  const actions = [];

  if (kind === "request") {
    if (hasSelection) {
      actions.push(["copySelection", "Copy"]);
      if (!readOnly) {
        actions.push(["pasteSelection", "Paste"]);
      }
      actions.push(["decode", "Decode as"]);
    } else {
      actions.push(["copyAll", "Copy All"]);
      if (!readOnly) {
        actions.push(["pasteAll", "Paste All"]);
      }
      actions.push(["selectAll", "Select All"]);
      actions.push(["download", "Download Request"]);
      actions.push(["sendRepeater", "Send to Repeater"]);
    }
  } else if (kind === "response") {
    if (hasSelection) {
      actions.push(["copySelection", "Copy"]);
      actions.push(["decode", "Decode as"]);
    } else {
      actions.push(["copyAll", "Copy All"]);
      actions.push(["selectAll", "Select All"]);
      actions.push(["download", "Download Response"]);
    }
  }

  els.editorMenu.replaceChildren(...actions.map(createEditorMenuItem));
}

function updateEditorSubmenuDirection() {
  const decodeItem = els.editorMenu.querySelector(".submenu-item");
  const submenu = els.editorMenu.querySelector(".submenu");
  if (!decodeItem || !submenu) {
    els.editorMenu.classList.remove("submenu-up");
    return;
  }

  submenu.hidden = false;
  const itemRect = decodeItem.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();
  submenu.hidden = true;

  const opensDownPastViewport = itemRect.top + submenuRect.height > window.innerHeight - 8;
  const hasMoreSpaceAbove = itemRect.bottom > window.innerHeight / 2;
  els.editorMenu.classList.toggle("submenu-up", opensDownPastViewport && hasMoreSpaceAbove);
}

function createEditorMenuItem([action, label]) {
  if (action === "decode") {
    const wrapper = document.createElement("div");
    wrapper.className = "submenu-item";

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;

    const submenu = document.createElement("div");
    submenu.className = "submenu";
    submenu.hidden = true;
    submenu.replaceChildren(
      createDecodeMenuButton("base64", "Base64"),
      createDecodeMenuButton("url", "URL"),
      createDecodeMenuButton("jwt", "JWT")
    );

    wrapper.addEventListener("mouseenter", () => {
      submenu.hidden = false;
    });
    wrapper.addEventListener("mouseleave", () => {
      submenu.hidden = true;
    });
    wrapper.append(button, submenu);
    return wrapper;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

function createDecodeMenuButton(format, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = "decode";
  button.dataset.format = format;
  button.textContent = label;
  return button;
}

async function handleEditorMenuClick(event) {
  const button = event.target.closest("button[data-action]");
  const target = state.editorMenuTarget;
  if (!button || !target) {
    return;
  }

  const { editor, kind } = target;
  const action = button.dataset.action;

  try {
    if (action === "copySelection") {
      await copyText(selectedEditorText(editor));
    } else if (action === "copyAll") {
      await copyText(editor.value);
    } else if (action === "pasteSelection") {
      replaceEditorSelection(editor, await readClipboardText());
    } else if (action === "pasteAll") {
      replaceEditorAll(editor, await readClipboardText());
    } else if (action === "selectAll") {
      editor.focus();
      editor.select();
    } else if (action === "download") {
      downloadTextFile(editor.value, `${kind}-${timestampForFilename()}.txt`);
    } else if (action === "sendRepeater") {
      sendRequestEditorToRepeater(editor);
    } else if (action === "decode") {
      showDecodedSelection(editor, button.dataset.format);
    }
  } catch (error) {
    window.alert(error.message || String(error));
  }

  hideEditorMenu();
}

function hideEditorMenu() {
  els.editorMenu.hidden = true;
  state.editorMenuTarget = null;
}

function editorKind(editor) {
  if ([els.requestText, els.repeaterRequest, els.interceptRequest].includes(editor)) {
    return "request";
  }
  if ([els.responseText, els.repeaterResponse].includes(editor)) {
    return "response";
  }
  return "";
}

function selectedEditorText(editor) {
  return editor.value.slice(editor.selectionStart, editor.selectionEnd);
}

function showDecodedSelection(editor, format) {
  const input = selectedEditorText(editor);
  const decoded = decodeText(input, format);
  const labels = {
    base64: "Base64",
    url: "URL",
    jwt: "JWT"
  };
  els.decodeTitle.textContent = `Decoded ${labels[format] || "Text"}`;
  els.decodeOutput.value = decoded;
  els.decodeDialog.hidden = false;
  els.decodeOutput.focus();
  els.decodeOutput.select();
}

function hideDecodeDialog() {
  els.decodeDialog.hidden = true;
  els.decodeOutput.value = "";
}

function decodeText(value, format) {
  if (format === "base64") {
    return decodeBase64(value);
  }
  if (format === "url") {
    return decodeUrlEncoded(value);
  }
  if (format === "jwt") {
    return decodeJwt(value);
  }
  throw new Error("Unsupported decoder.");
}

function decodeBase64(value) {
  const normalized = value.trim().replace(/\s+/g, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeUrlEncoded(value) {
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function decodeJwt(value) {
  const token = value.trim();
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("JWT must contain at least header and payload.");
  }

  const header = JSON.parse(decodeBase64Url(parts[0]));
  const payload = JSON.parse(decodeBase64Url(parts[1]));
  const signature = parts[2] || "";
  return JSON.stringify({ header, payload, signature }, null, 2);
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return decodeBase64(base64);
}

async function readClipboardText() {
  if (navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }
  throw new Error("Clipboard read is not available.");
}

function replaceEditorSelection(editor, value) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = `${editor.value.slice(0, start)}${value}${editor.value.slice(end)}`;
  editor.setSelectionRange(start, start + value.length);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  updateEditorHighlight(editor);
}

function replaceEditorAll(editor, value) {
  editor.value = value;
  editor.setSelectionRange(0, editor.value.length);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  updateEditorHighlight(editor);
}

function sendRequestEditorToRepeater(editor) {
  if (editor === els.requestText) {
    const entry = selectedEntry();
    if (entry) {
      sendEntryToRepeater(entry);
      return;
    }
  }

  syncActiveRepeaterTab();
  const tab = createRepeaterTabFromRawRequest(editor.value);
  state.repeaterTabs.push(tab);
  state.activeRepeaterId = tab.id;
  renderRepeater();
  switchView("repeater");
}

function createRepeaterTabFromRawRequest(rawText) {
  const request = parseRawRequest(rawText);
  const url = new URL(request.url);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `${request.method} ${url.pathname || "/"}`,
    sourceEntryId: null,
    requestText: rawText,
    responseText: "",
    meta: "Not sent",
    requestPaneSize: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function downloadTextFile(text, filename) {
  downloadBlob(new Blob([text], { type: "text/plain" }), filename);
}

function downloadJsonFile(value, filename) {
  downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function showPositionedMenu(menu, clientX, clientY) {
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function deleteHistoryEntry(entryId) {
  state.entries = state.entries.filter((entry) => entry.id !== entryId);
  if (state.selectedId === entryId) {
    state.selectedId = state.entries[0]?.id || null;
    renderDetail();
  }
  renderHistory();
}

async function toggleHistoryEntryUrlBlock(url) {
  if (state.blockedUrls.has(url)) {
    await sendRuntimeMessage({ type: "block:remove", url });
    state.blockedUrls.delete(url);
  } else {
    await sendRuntimeMessage({ type: "block:add", url });
    state.blockedUrls.add(url);
  }
  renderHistory();
}

async function toggleHistoryEntryUrlIntercept(url) {
  if (state.interceptUrls.has(url)) {
    await removeInterceptUrl(url);
    return;
  } else {
    state.interceptUrls.add(url);
  }

  renderHistory();
  renderInterceptUrlList();
  if (state.mode === "intercept") {
    await sendRuntimeMessage({
      type: "intercept:setUrls",
      tabId: state.inspectedTabId,
      urls: Array.from(state.interceptUrls)
    }).catch(() => {});
  }
}

async function removeInterceptUrl(url) {
  state.interceptUrls.delete(url);
  renderHistory();
  renderInterceptUrlList();
  await syncInterceptUrls();
}

async function updateInterceptUrl(oldUrl, nextUrl) {
  const normalizedUrl = nextUrl.trim();
  if (!normalizedUrl || normalizedUrl === oldUrl) {
    renderInterceptUrlList();
    return;
  }

  state.interceptUrls.delete(oldUrl);
  state.interceptUrls.add(normalizedUrl);
  renderHistory();
  renderInterceptUrlList();
  await syncInterceptUrls();
}

async function syncInterceptUrls() {
  if (state.mode !== "intercept") {
    return;
  }

  await sendRuntimeMessage({
    type: "intercept:setUrls",
    tabId: state.inspectedTabId,
    urls: Array.from(state.interceptUrls)
  }).catch(() => {});
}

function renderInterceptUrlList() {
  els.interceptUrlList.replaceChildren(...Array.from(state.interceptUrls).map((url, index) => {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "intercept-url-row";

    const id = document.createElement("span");
    id.className = "intercept-url-id";
    id.textContent = index + 1;

    const text = document.createElement("span");
    text.title = url;
    text.textContent = url;
    text.addEventListener("dblclick", () => {
      editInterceptUrl(row, url);
    });
    text.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      state.interceptMenuTargetUrl = url;
      showInterceptUrlMenu(event.clientX, event.clientY);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-intercept-url";
    remove.title = "Remove intercept URL";
    remove.textContent = "x";
    remove.addEventListener("click", async () => {
      await toggleHistoryEntryUrlIntercept(url);
    });

    row.append(id, text, remove);
    item.append(row);
    return item;
  }));
}

function editInterceptUrl(row, url) {
  const currentText = row.children[1];
  const input = document.createElement("input");
  input.className = "intercept-url-input";
  input.value = url;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      await updateInterceptUrl(url, input.value);
    }
    if (event.key === "Escape") {
      renderInterceptUrlList();
    }
  });
  input.addEventListener("blur", async () => {
    await updateInterceptUrl(url, input.value);
  });

  currentText.replaceWith(input);
  input.focus();
  input.select();
}

function showInterceptUrlMenu(clientX, clientY) {
  showPositionedMenu(els.interceptUrlMenu, clientX, clientY);
}

function hideInterceptUrlMenu() {
  els.interceptUrlMenu.hidden = true;
  state.interceptMenuTargetUrl = null;
}

function hideTransientMenus() {
  hideHighlightMenu();
  hideUrlMenu();
  hideInterceptUrlMenu();
  hideEditorMenu();
}

function formatHistoryTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function isHiddenByExtension(entry) {
  const extension = requestExtension(entry.request.url);
  return extension ? state.hiddenExtensions.has(extension) : false;
}

function requestExtension(urlValue) {
  try {
    const url = new URL(urlValue);
    const pathname = url.pathname.toLowerCase();
    const lastSegment = pathname.split("/").pop() || "";
    const dotIndex = lastSegment.lastIndexOf(".");
    return dotIndex >= 0 ? lastSegment.slice(dotIndex + 1) : "";
  } catch (_error) {
    return "";
  }
}

function renderDetail() {
  const entry = selectedEntry();
  els.detailSplit.style.setProperty("--detail-request-pane-size", state.detailRequestPaneSize || "1fr");

  if (!entry) {
    els.requestText.value = "";
    els.responseText.value = "";
    els.responseMeta.textContent = "";
    updateEditorHighlight(els.requestText);
    updateEditorHighlight(els.responseText);
    return;
  }

  els.requestText.value = formatRawRequest(entry.request);
  els.responseText.value = formatRawResponse(entry.response);
  els.responseMeta.textContent = `${entry.response.status} ${entry.response.statusText} | ${entry.time} ms`;
  updateEditorHighlight(els.requestText);
  updateEditorHighlight(els.responseText);
}

function createRepeaterTab(entry) {
  const url = new URL(entry.request.url);
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `${entry.request.method} ${url.pathname || "/"}`,
    sourceEntryId: entry.id,
    requestText: formatRawRequest(entry.request),
    responseText: "",
    meta: "Not sent",
    requestPaneSize: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function sendEntryToRepeater(entry) {
  syncActiveRepeaterTab();
  const tab = createRepeaterTab(entry);
  state.repeaterTabs.push(tab);
  state.activeRepeaterId = tab.id;
  renderRepeater();
  switchView("repeater");
}

function renderRepeater() {
  renderRepeaterTabs();
  renderRepeaterEditors();
}

function renderRepeaterTabs() {
  els.repeaterTabList.replaceChildren(...state.repeaterTabs.map((tab) => {
    const wrapper = document.createElement("div");
    wrapper.className = `repeater-tab${tab.id === state.activeRepeaterId ? " active" : ""}`;
    wrapper.dataset.tabId = tab.id;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "repeater-tab-main";
    button.title = tab.title;
    button.addEventListener("click", () => {
      syncActiveRepeaterTab();
      state.activeRepeaterId = tab.id;
      renderRepeater();
    });
    button.addEventListener("dblclick", () => {
      renameRepeaterTab(tab.id);
    });

    const label = document.createElement("span");
    label.className = "repeater-tab-label";
    label.textContent = tab.title;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close-tab";
    close.title = "Close repeater tab";
    close.textContent = "x";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeRepeaterTab(tab.id);
    });

    button.append(label);
    wrapper.append(button, close);
    return wrapper;
  }));
}

function renderRepeaterEditors() {
  const tab = activeRepeaterTab();
  const hasTab = Boolean(tab);
  els.emptyRepeater.classList.toggle("active", !hasTab);
  els.repeaterEditors.style.display = hasTab ? "grid" : "none";

  if (!tab) {
    els.repeaterRequest.value = "";
    els.repeaterResponse.value = "";
    els.repeaterMeta.textContent = "";
    updateEditorHighlight(els.repeaterRequest);
    updateEditorHighlight(els.repeaterResponse);
    return;
  }

  els.repeaterEditors.style.setProperty("--request-pane-size", tab.requestPaneSize || "1fr");
  els.repeaterRequest.value = tab.requestText;
  els.repeaterResponse.value = tab.responseText;
  els.repeaterMeta.textContent = tab.meta;
  updateEditorHighlight(els.repeaterRequest);
  updateEditorHighlight(els.repeaterResponse);
}

function closeRepeaterTab(tabId) {
  syncActiveRepeaterTab();
  const index = state.repeaterTabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) {
    return;
  }

  state.repeaterTabs.splice(index, 1);
  if (state.activeRepeaterId === tabId) {
    state.activeRepeaterId = state.repeaterTabs[index]?.id || state.repeaterTabs[index - 1]?.id || null;
  }
  renderRepeater();
}

function activeRepeaterTab() {
  return state.repeaterTabs.find((tab) => tab.id === state.activeRepeaterId);
}

function syncActiveRepeaterTab() {
  const tab = activeRepeaterTab();
  if (!tab) {
    return;
  }
  tab.requestText = els.repeaterRequest.value;
  tab.responseText = els.repeaterResponse.value;
  tab.meta = els.repeaterMeta.textContent || tab.meta;
  tab.updatedAt = new Date().toISOString();
}

function renameRepeaterTab(tabId) {
  const tab = state.repeaterTabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    return;
  }

  const wrapper = els.repeaterTabList.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`);
  const button = wrapper?.querySelector(".repeater-tab-main");
  if (!button) {
    return;
  }

  const input = document.createElement("input");
  input.className = "tab-name-input";
  input.value = tab.title;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("dblclick", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      commitRepeaterTabName(tab, input.value);
    }
    if (event.key === "Escape") {
      renderRepeaterTabs();
    }
  });
  input.addEventListener("blur", () => {
    commitRepeaterTabName(tab, input.value);
  });

  button.replaceChildren(input);
  input.focus();
  input.select();
}

function commitRepeaterTabName(tab, value) {
  const nextTitle = value.trim();
  if (nextTitle) {
    tab.title = nextTitle;
    tab.updatedAt = new Date().toISOString();
  }
  renderRepeaterTabs();
}

function startRepeaterResize(event) {
  const tab = activeRepeaterTab();
  if (!tab) {
    return;
  }

  event.preventDefault();
  els.repeaterResizeHandle.setPointerCapture(event.pointerId);

  const onPointerMove = (moveEvent) => {
    setRepeaterRequestPaneSize(tab, moveEvent.clientY);
  };
  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp, { once: true });
}

function setRepeaterRequestPaneSize(tab, clientY) {
  const rect = els.repeaterEditors.getBoundingClientRect();
  const handleHeight = els.repeaterResizeHandle.getBoundingClientRect().height;
  const minPaneHeight = 140;
  const maxHeight = Math.max(minPaneHeight, rect.height - handleHeight - minPaneHeight);
  const nextHeight = Math.min(Math.max(clientY - rect.top, minPaneHeight), maxHeight);
  tab.requestPaneSize = `${Math.round(nextHeight)}px`;
  tab.updatedAt = new Date().toISOString();
  els.repeaterEditors.style.setProperty("--request-pane-size", tab.requestPaneSize);
}

function resizeRepeaterWithKeyboard(event) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }

  const tab = activeRepeaterTab();
  if (!tab) {
    return;
  }

  event.preventDefault();
  const rect = els.repeaterEditors.getBoundingClientRect();
  const current = parseInt(tab.requestPaneSize, 10) || Math.round((rect.height - 8) / 2);
  const step = event.shiftKey ? 60 : 20;
  let next = current;

  if (event.key === "ArrowUp") {
    next -= step;
  } else if (event.key === "ArrowDown") {
    next += step;
  } else if (event.key === "Home") {
    next = 140;
  } else if (event.key === "End") {
    next = rect.height - 148;
  }

  setRepeaterRequestPaneSize(tab, rect.top + next);
}

function startWorkspaceResize(event) {
  event.preventDefault();
  els.workspaceResizeHandle.setPointerCapture(event.pointerId);

  const onPointerMove = (moveEvent) => {
    setWorkspacePaneSize(moveEvent.clientX, moveEvent.clientY);
  };
  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp, { once: true });
}

function setWorkspacePaneSize(clientX, clientY) {
  const rect = els.workspace.getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  const minPrimary = 220;
  const minSecondary = mobile ? 320 : 360;
  const handleSize = 8;

  if (mobile) {
    const maxHeight = Math.max(minPrimary, rect.height - handleSize - minSecondary);
    const nextHeight = Math.min(Math.max(clientY - rect.top, minPrimary), maxHeight);
    state.historyPaneSize = `${Math.round(nextHeight)}px`;
    els.workspace.style.setProperty("--history-pane-size", state.historyPaneSize);
    return;
  }

  const maxWidth = Math.max(minPrimary, rect.width - handleSize - minSecondary);
  const nextWidth = Math.min(Math.max(clientX - rect.left, minPrimary), maxWidth);
  state.historyPaneSize = `${Math.round(nextWidth)}px`;
  els.workspace.style.setProperty("--history-pane-size", state.historyPaneSize);
}

function resizeWorkspaceWithKeyboard(event) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const rect = els.workspace.getBoundingClientRect();
  const mobile = window.matchMedia("(max-width: 900px)").matches;
  const current = parseInt(state.historyPaneSize, 10) || Math.round((mobile ? rect.height : rect.width) * 0.36);
  const step = event.shiftKey ? 60 : 20;
  let next = current;

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    next -= step;
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    next += step;
  } else if (event.key === "Home") {
    next = 220;
  } else if (event.key === "End") {
    next = (mobile ? rect.height : rect.width) - 368;
  }

  setWorkspacePaneSize(rect.left + next, rect.top + next);
}

function startDetailResize(event) {
  event.preventDefault();
  els.detailResizeHandle.setPointerCapture(event.pointerId);

  const onPointerMove = (moveEvent) => {
    setDetailRequestPaneSize(moveEvent.clientY);
  };
  const onPointerUp = () => {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp, { once: true });
}

function setDetailRequestPaneSize(clientY) {
  const rect = els.detailSplit.getBoundingClientRect();
  const handleHeight = els.detailResizeHandle.getBoundingClientRect().height;
  const minPaneHeight = 140;
  const maxHeight = Math.max(minPaneHeight, rect.height - handleHeight - minPaneHeight);
  const nextHeight = Math.min(Math.max(clientY - rect.top, minPaneHeight), maxHeight);
  state.detailRequestPaneSize = `${Math.round(nextHeight)}px`;
  els.detailSplit.style.setProperty("--detail-request-pane-size", state.detailRequestPaneSize);
}

function resizeDetailWithKeyboard(event) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }

  event.preventDefault();
  const rect = els.detailSplit.getBoundingClientRect();
  const current = parseInt(state.detailRequestPaneSize, 10) || Math.round((rect.height - 8) / 2);
  const step = event.shiftKey ? 60 : 20;
  let next = current;

  if (event.key === "ArrowUp") {
    next -= step;
  } else if (event.key === "ArrowDown") {
    next += step;
  } else if (event.key === "Home") {
    next = 140;
  } else if (event.key === "End") {
    next = rect.height - 148;
  }

  setDetailRequestPaneSize(rect.top + next);
}

function applyLayoutSizes() {
  if (state.historyPaneSize) {
    els.workspace.style.setProperty("--history-pane-size", state.historyPaneSize);
  }
  els.detailSplit.style.setProperty("--detail-request-pane-size", state.detailRequestPaneSize || "1fr");
  applyHistoryColumnSizes();
}

function updateAllEditorHighlights() {
  for (const editor of els.rawEditors) {
    updateEditorHighlight(editor);
  }
}

function handleEditorFindShortcut(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f") {
    return;
  }

  const editor = editorFromFindEvent(event);
  if (!editor) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openEditorFind(editor);
}

function editorFromFindEvent(event) {
  if (els.rawEditors.includes(event.target)) {
    return event.target;
  }

  if (findState.input && event.target === findState.input) {
    return findState.editor;
  }

  return null;
}

function openEditorFind(editor) {
  if (findState.editor !== editor) {
    closeEditorFind();
  }

  if (!findState.bar) {
    createEditorFindBar(editor);
  }

  findState.editor = editor;
  editor.closest(".highlight-editor")?.classList.add("find-open");
  findState.bar.hidden = false;

  const selectedText = editor.selectionStart !== editor.selectionEnd
    ? editor.value.slice(editor.selectionStart, editor.selectionEnd)
    : "";
  if (selectedText && !selectedText.includes("\n")) {
    findState.input.value = selectedText;
  }

  updateEditorFindMatches();
  findState.input.focus();
  findState.input.select();
}

function createEditorFindBar(editor) {
  const wrapper = editor.closest(".highlight-editor");
  if (!wrapper) {
    return;
  }

  const bar = document.createElement("div");
  bar.className = "editor-find-bar";
  bar.hidden = true;

  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "Find";
  input.autocomplete = "off";
  input.spellcheck = false;

  const count = document.createElement("span");
  count.className = "editor-find-count";
  count.textContent = "0/0";

  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "editor-find-button";
  previous.title = "Previous match";
  previous.textContent = "Prev";

  const next = document.createElement("button");
  next.type = "button";
  next.className = "editor-find-button";
  next.title = "Next match";
  next.textContent = "Next";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "editor-find-button";
  close.title = "Close search";
  close.textContent = "x";

  bar.addEventListener("mousedown", (event) => event.stopPropagation());
  input.addEventListener("input", updateEditorFindMatches);
  input.addEventListener("keydown", handleEditorFindKeydown);
  previous.addEventListener("click", () => moveEditorFind(-1, true));
  next.addEventListener("click", () => moveEditorFind(1, true));
  close.addEventListener("click", closeEditorFind);

  bar.append(input, count, previous, next, close);
  wrapper.append(bar);

  findState.bar = bar;
  findState.input = input;
  findState.count = count;
}

function handleEditorFindKeydown(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    moveEditorFind(event.shiftKey ? -1 : 1, true);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeEditorFind();
  }
}

function updateEditorFindMatches() {
  const editor = findState.editor;
  const query = findState.input?.value || "";
  findState.matches = [];
  findState.index = -1;

  if (!editor || !query) {
    updateEditorFindCount();
    return;
  }

  const haystack = editor.value.toLowerCase();
  const needle = query.toLowerCase();
  let fromIndex = 0;
  while (fromIndex <= haystack.length) {
    const index = haystack.indexOf(needle, fromIndex);
    if (index < 0) {
      break;
    }
    findState.matches.push(index);
    fromIndex = index + Math.max(needle.length, 1);
  }

  if (findState.matches.length) {
    const caret = editor.selectionStart || 0;
    findState.index = findState.matches.findIndex((match) => match >= caret);
    if (findState.index < 0) {
      findState.index = 0;
    }
    selectEditorFindMatch(false);
  }

  updateEditorFindCount();
}

function moveEditorFind(direction, focusEditor) {
  if (!findState.matches.length) {
    updateEditorFindMatches();
    return;
  }

  findState.index = (findState.index + direction + findState.matches.length) % findState.matches.length;
  selectEditorFindMatch(focusEditor);
  updateEditorFindCount();
}

function selectEditorFindMatch(focusEditor) {
  const editor = findState.editor;
  const query = findState.input?.value || "";
  const start = findState.matches[findState.index];
  if (!editor || start === undefined || !query) {
    return;
  }

  editor.setSelectionRange(start, start + query.length);
  editor.scrollTop = editor.scrollTop;
  if (focusEditor) {
    editor.focus();
  }
}

function updateEditorFindCount() {
  if (!findState.count) {
    return;
  }

  const total = findState.matches.length;
  findState.count.textContent = total ? `${findState.index + 1}/${total}` : "0/0";
}

function closeEditorFind() {
  if (!findState.bar) {
    return;
  }

  findState.bar.hidden = true;
  findState.editor?.closest(".highlight-editor")?.classList.remove("find-open");
  findState.editor?.focus();
  findState.editor = null;
  findState.input = null;
  findState.count = null;
  findState.bar.remove();
  findState.bar = null;
  findState.matches = [];
  findState.index = -1;
}

function updateEditorHighlight(editor) {
  const layer = editor.previousElementSibling;
  if (!layer?.classList.contains("highlight-layer")) {
    return;
  }
  layer.innerHTML = highlightRawMessage(editor.value);
  syncEditorScroll(editor);
}

function syncEditorScroll(editor) {
  const layer = editor.previousElementSibling;
  if (!layer?.classList.contains("highlight-layer")) {
    return;
  }
  layer.scrollTop = editor.scrollTop;
  layer.scrollLeft = editor.scrollLeft;
}

function highlightRawMessage(rawText) {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const head = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const body = separator >= 0 ? normalized.slice(separator + 2) : "";
  const highlightedHead = head.split("\n").map(highlightHeaderLine).join("\n");

  if (separator < 0) {
    return highlightedHead || " ";
  }

  return `${highlightedHead}\n\n${highlightBody(body) || " "}`;
}

function highlightHeaderLine(line) {
  const colon = line.indexOf(":");
  if (colon <= 0 || /^\S+\s+\S+/.test(line)) {
    return escapeHtml(line);
  }

  const name = line.slice(0, colon + 1);
  const value = line.slice(colon + 1);
  return `<span class="tok-header-name">${escapeHtml(name)}</span><span class="tok-header-value">${escapeHtml(value)}</span>`;
}

function highlightBody(body) {
  if (!body || !looksLikeParameterBody(body)) {
    return escapeHtml(body);
  }

  return body.split(/([&;\n])/).map((part) => {
    if (part === "&" || part === ";" || part === "\n") {
      return escapeHtml(part);
    }

    const equals = part.indexOf("=");
    if (equals < 0) {
      return escapeHtml(part);
    }

    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    return `<span class="tok-param-name">${escapeHtml(name)}</span>=<span class="tok-param-value">${escapeHtml(value)}</span>`;
  }).join("");
}

function looksLikeParameterBody(body) {
  return /(^|[&;\n])[^&;\n=]+=[^&;\n]*/.test(body);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendRuntimeMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || !result.ok) {
    throw new Error(result?.error || "Extension command failed.");
  }
  return result;
}

async function sendRepeaterRequest(parsedRequest) {
  const debuggerResult = await chrome.runtime.sendMessage({
    type: "repeater:sendDebugger",
    tabId: state.inspectedTabId,
    request: parsedRequest
  });

  if (debuggerResult?.ok && debuggerResult.response?.status !== 0) {
    return {
      response: debuggerResult.response,
      transport: "debugger"
    };
  }

  const debuggerFailure = debuggerResult?.ok && debuggerResult.response?.status === 0
    ? "Debugger repeater returned an opaque redirect with status 0."
    : debuggerResult?.error;

  const backgroundResult = await chrome.runtime.sendMessage({
    type: "repeater:send",
    request: parsedRequest
  });

  if (backgroundResult?.ok) {
    if (backgroundResult.response?.status === 0) {
      throw new Error("Repeater could not capture the real redirect status. Reload the extension and try again.");
    }
    return {
      response: backgroundResult.response,
      transport: "extension"
    };
  }

  const backgroundError = backgroundResult?.error || "Extension fetch failed.";
  const debuggerError = debuggerFailure ? `Debugger repeater failed: ${debuggerFailure}\n` : "";
  try {
    const response = await sendRepeaterRequestFromInspectedPage(parsedRequest);
    if (response?.status === 0) {
      throw new Error("Page fallback returned an opaque redirect with status 0.");
    }
    return {
      response,
      transport: "page"
    };
  } catch (fallbackError) {
    throw new Error(`${debuggerError}${backgroundError}\nPage fallback failed: ${fallbackError.message || String(fallbackError)}`);
  }
}

function sendRepeaterRequestFromInspectedPage(parsedRequest) {
  const expression = `(${inspectedPageFetchSource()})(${JSON.stringify(parsedRequest)})`;
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, { useContentScriptContext: false }, (result, exceptionInfo) => {
      if (exceptionInfo) {
        reject(new Error(exceptionInfo.value || exceptionInfo.description || "Inspected page evaluation failed."));
        return;
      }
      if (!result || !result.ok) {
        reject(new Error(result?.error || "Inspected page fetch failed."));
        return;
      }
      resolve(result.response);
    });
  });
}

function inspectedPageFetchSource() {
  return String(async function inspectedPageFetch(request) {
    function forbiddenHeader(name) {
      const normalized = name.toLowerCase();
      return [
        "accept-charset",
        "accept-encoding",
        "access-control-request-headers",
        "access-control-request-method",
        "connection",
        "content-length",
        "cookie",
        "date",
        "dnt",
        "expect",
        "host",
        "keep-alive",
        "origin",
        "permissions-policy",
        "referer",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "via"
      ].includes(normalized) || normalized.startsWith("proxy-") || normalized.startsWith("sec-") || normalized.startsWith(":");
    }

    try {
      const headers = new Headers();
      const skippedHeaders = [];
      for (const [name, value] of Object.entries(request.headers || {})) {
        if (forbiddenHeader(name)) {
          skippedHeaders.push(name);
          continue;
        }
        headers.set(name, value);
      }

      const options = {
        method: request.method || "GET",
        headers,
        credentials: "include",
        redirect: "manual",
        cache: "no-store"
      };

      if (!["GET", "HEAD"].includes(options.method.toUpperCase()) && request.body) {
        options.body = request.body;
      }

      const startedAt = Date.now();
      const fetchResponse = await fetch(request.url, options);
      const body = await fetchResponse.text();
      const responseHeaders = {};
      fetchResponse.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });

      return {
        ok: true,
        response: {
          url: fetchResponse.url,
          status: fetchResponse.status,
          statusText: fetchResponse.statusText,
          headers: responseHeaders,
          body,
          durationMs: Date.now() - startedAt,
          skippedHeaders
        }
      };
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error)
      };
    }
  });
}

async function forwardCurrentIntercept() {
  try {
    await sendRuntimeMessage({
      type: "intercept:forward",
      tabId: state.inspectedTabId,
      rawMessage: els.interceptRequest.value
    });
    clearInterceptEditor("Forwarded. Waiting for request");
  } catch (error) {
    els.interceptStatus.textContent = error.message || String(error);
  }
}

async function dropCurrentIntercept() {
  try {
    await sendRuntimeMessage({
      type: "intercept:drop",
      tabId: state.inspectedTabId
    });
    clearInterceptEditor("Dropped. Waiting for request");
  } catch (error) {
    els.interceptStatus.textContent = error.message || String(error);
  }
}

function clearInterceptEditor(status) {
  state.pausedInterceptId = null;
  els.interceptStatus.textContent = status;
  els.interceptRequest.value = "";
  updateEditorHighlight(els.interceptRequest);
}

function selectedEntry() {
  return state.entries.find((entry) => entry.id === state.selectedId);
}

function switchView(viewName) {
  syncActiveRepeaterTab();
  state.activeView = viewName;
  for (const tab of els.tabs) {
    tab.classList.toggle("active", tab.dataset.view === viewName);
  }
  for (const [name, view] of Object.entries(els.views)) {
    view.classList.toggle("active", name === viewName);
  }
}

function downloadProject() {
  syncActiveRepeaterTab();
  const project = {
    schema: "interceptor-project-v1",
    exportedAt: new Date().toISOString(),
    history: state.entries,
    selectedId: state.selectedId,
    nextSequenceId: state.nextSequenceId,
    repeaterTabs: state.repeaterTabs,
    activeRepeaterId: state.activeRepeaterId
  };
  downloadJsonFile(project, `interceptor-project-${timestampForFilename()}.json`);
}

async function uploadProject(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) {
    return;
  }

  try {
    const project = JSON.parse(await file.text());
    if (project.schema !== "interceptor-project-v1") {
      throw new Error("Unsupported project file.");
    }

    state.entries = Array.isArray(project.history)
      ? project.history.slice(0, MAX_HISTORY).map(normalizeProjectHistoryEntry)
      : [];
    state.selectedId = state.entries.some((entry) => entry.id === project.selectedId)
      ? project.selectedId
      : state.entries[0]?.id || null;
    state.nextSequenceId = Math.max(
      Number.isInteger(project.nextSequenceId) ? project.nextSequenceId : 1,
      nextSequenceIdFromEntries()
    );
    state.sort = normalizeProjectSort(project.sort);
    state.blockedUrls = new Set();
    state.interceptUrls = new Set();
    state.repeaterTabs = Array.isArray(project.repeaterTabs)
      ? project.repeaterTabs.map(normalizeProjectRepeaterTab)
      : [];
    state.activeRepeaterId = state.repeaterTabs.some((tab) => tab.id === project.activeRepeaterId)
      ? project.activeRepeaterId
      : state.repeaterTabs[0]?.id || null;

    renderHistory();
    renderExtensionFilters();
    renderInterceptUrlList();
    renderDetail();
    renderRepeater();
  } catch (error) {
    window.alert(`Project upload failed: ${error.message || String(error)}`);
  }
}

function normalizeProjectRepeaterTab(tab) {
  return {
    id: typeof tab.id === "string" ? tab.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: typeof tab.title === "string" ? tab.title : "Repeater",
    sourceEntryId: typeof tab.sourceEntryId === "string" ? tab.sourceEntryId : null,
    requestText: typeof tab.requestText === "string" ? tab.requestText : "",
    responseText: typeof tab.responseText === "string" ? tab.responseText : "",
    meta: typeof tab.meta === "string" ? tab.meta : "Not sent",
    requestPaneSize: typeof tab.requestPaneSize === "string" ? tab.requestPaneSize : null,
    createdAt: typeof tab.createdAt === "string" ? tab.createdAt : new Date().toISOString(),
    updatedAt: typeof tab.updatedAt === "string" ? tab.updatedAt : new Date().toISOString()
  };
}

function normalizeProjectHistoryEntry(entry, index) {
  return {
    ...entry,
    id: typeof entry.id === "string" ? entry.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    sequenceId: Number.isInteger(entry.sequenceId) ? entry.sequenceId : index + 1,
    highlight: ["red", "yellow", "blue", "green", "purple"].includes(entry.highlight) ? entry.highlight : ""
  };
}

function nextSequenceIdFromEntries() {
  const maxSequenceId = state.entries.reduce((max, entry) => {
    return Math.max(max, Number.isInteger(entry.sequenceId) ? entry.sequenceId : 0);
  }, 0);
  return maxSequenceId + 1;
}

function normalizeProjectSort(sort) {
  const allowedKeys = ["sequenceId", "method", "status", "url", "timestamp"];
  if (!sort || !allowedKeys.includes(sort.key)) {
    return { key: "sequenceId", direction: "desc" };
  }
  return {
    key: sort.key,
    direction: sort.direction === "asc" ? "asc" : "desc"
  };
}

function normalizeProjectHistoryColumns(columns) {
  const normalized = { ...DEFAULT_HISTORY_COLUMNS };
  if (!columns || typeof columns !== "object") {
    return normalized;
  }

  for (const name of Object.keys(DEFAULT_HISTORY_COLUMNS)) {
    const value = Number(columns[name]);
    if (Number.isFinite(value)) {
      normalized[name] = Math.max(MIN_HISTORY_COLUMNS[name], Math.round(value));
    }
  }
  return normalized;
}

function formatRawRequest(request) {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const firstLine = `${request.method} ${path || "/"} ${formatHttpVersion(request.httpVersion)}`;
  const headers = {
    Host: url.host,
    ...request.headers
  };

  return `${firstLine}\n${formatHeaders(headers)}\n\n${request.body || ""}`;
}

function formatRawResponse(response) {
  const firstLine = `${formatHttpVersion(response.httpVersion)} ${response.status} ${response.statusText || ""}`.trim();
  const body = response.encoding === "base64"
    ? `[base64 encoded body]\n\n${response.body || ""}`
    : response.body || "";

  return `${firstLine}\n${formatHeaders(response.headers)}\n\n${body}`;
}

function formatHttpVersion(value) {
  const version = String(value || "HTTP/1.1").toLowerCase();
  if (version === "h3" || version === "http/3" || version === "http/3.0") {
    return "HTTP/3";
  }
  if (version === "h2" || version === "http/2" || version === "http/2.0") {
    return "HTTP/2";
  }
  if (version === "http/1.0" || version === "http/1.1") {
    return version.toUpperCase();
  }
  return value || "HTTP/1.1";
}

function formatHeaders(headers) {
  return Object.entries(headers || {})
    .filter(([name]) => !isPseudoHeader(name))
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function parseRawRequest(rawText) {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const head = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const body = separator >= 0 ? normalized.slice(separator + 2) : "";
  const lines = head.split("\n").filter(Boolean);
  const requestLine = lines.shift();

  if (!requestLine) {
    throw new Error("Request line is required.");
  }

  const [method, target] = requestLine.split(/\s+/);
  if (!method || !target) {
    throw new Error("Request line must look like: GET /path HTTP/1.1");
  }

  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (line.startsWith(":")) {
      continue;
    }
    if (colon <= 0) {
      throw new Error(`Invalid header: ${line}`);
    }
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  const host = findHeader(headers, "host");
  const url = target.startsWith("http://") || target.startsWith("https://")
    ? target
    : `${inferScheme(headers)}://${host}${target.startsWith("/") ? target : `/${target}`}`;

  if (!host && !target.startsWith("http")) {
    throw new Error("Host header is required for relative request targets.");
  }

  deleteHeader(headers, "host");

  return {
    method: method.toUpperCase(),
    url,
    headers,
    body
  };
}

function findHeader(headers, wantedName) {
  const match = Object.keys(headers).find((name) => name.toLowerCase() === wantedName);
  return match ? headers[match] : "";
}

function deleteHeader(headers, wantedName) {
  const match = Object.keys(headers).find((name) => name.toLowerCase() === wantedName);
  if (match) {
    delete headers[match];
  }
}

function inferScheme(headers) {
  const referer = findHeader(headers, "referer");
  if (referer) {
    try {
      return new URL(referer).protocol.replace(":", "");
    } catch (_error) {
      return "https";
    }
  }
  return "https";
}

function isPseudoHeader(name) {
  return typeof name === "string" && name.startsWith(":");
}

async function initializeDebuggerSession() {
  await sendRuntimeMessage({
    type: "debugger:attach",
    tabId: state.inspectedTabId
  }).catch(() => {});
}

async function initializePanel() {
  await restoreTheme();
  renderExtensionFilters();
  applyLayoutSizes();
  renderHistory();
  renderDetail();
  renderRepeater();
  updateAllEditorHighlights();
  initializeDebuggerSession();
}

initializePanel();
