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
  interceptPollId: null,
  pausedInterceptId: null
};

const els = {
  modeSelect: document.querySelector("#modeSelect"),
  downloadProject: document.querySelector("#downloadProject"),
  uploadProject: document.querySelector("#uploadProject"),
  projectFile: document.querySelector("#projectFile"),
  toggleCapture: document.querySelector("#toggleCapture"),
  clearHistory: document.querySelector("#clearHistory"),
  searchInput: document.querySelector("#searchInput"),
  extensionFilterList: document.querySelector("#extensionFilterList"),
  historyTable: document.querySelector("#historyTable"),
  requestList: document.querySelector("#requestList"),
  historySortButtons: Array.from(document.querySelectorAll(".history-sort")),
  columnResizers: Array.from(document.querySelectorAll(".column-resizer")),
  highlightMenu: document.querySelector("#highlightMenu"),
  urlMenu: document.querySelector("#urlMenu"),
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
  interceptForward: document.querySelector("#interceptForward"),
  interceptDrop: document.querySelector("#interceptDrop"),
  interceptRequest: document.querySelector("#interceptRequest"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  views: {
    detail: document.querySelector("#detailView"),
    repeater: document.querySelector("#repeaterView"),
    intercept: document.querySelector("#interceptView")
  }
};

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
  setMode(state.mode === "capturing" ? "paused" : "capturing");
});

els.modeSelect.addEventListener("change", () => {
  setMode(els.modeSelect.value);
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
  } else if (button.dataset.action === "block") {
    await blockHistoryEntryUrl(entry.request.url);
  }

  hideUrlMenu();
});

document.addEventListener("click", () => {
  hideHighlightMenu();
  hideUrlMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideHighlightMenu();
    hideUrlMenu();
  }
});

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
  syncActiveRepeaterTab();
  const tab = createRepeaterTab(entry);
  state.repeaterTabs.push(tab);
  state.activeRepeaterId = tab.id;
  renderRepeater();
  switchView("repeater");
});

els.sendRequest.addEventListener("click", async () => {
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
    const result = await chrome.runtime.sendMessage({
      type: "repeater:send",
      request: parsed
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || "Request failed.");
    }

    const skipped = result.response.skippedHeaders?.length
      ? ` | skipped: ${result.response.skippedHeaders.join(", ")}`
      : "";
    tab.meta = `${result.response.status} ${result.response.statusText} | ${result.response.durationMs} ms${skipped}`;
    tab.responseText = formatRawResponse(result.response);
    tab.updatedAt = new Date().toISOString();
  } catch (error) {
    tab.meta = "Error";
    tab.responseText = error.message || String(error);
  }

  renderRepeaterEditors();
});

els.interceptForward.addEventListener("click", async () => {
  try {
    await sendRuntimeMessage({
      type: "intercept:forward",
      tabId: state.inspectedTabId,
      rawRequest: els.interceptRequest.value
    });
    clearInterceptEditor("Forwarded. Waiting for request");
  } catch (error) {
    els.interceptStatus.textContent = error.message || String(error);
  }
});

els.interceptDrop.addEventListener("click", async () => {
  try {
    await sendRuntimeMessage({
      type: "intercept:drop",
      tabId: state.inspectedTabId
    });
    clearInterceptEditor("Dropped. Waiting for request");
  } catch (error) {
    els.interceptStatus.textContent = error.message || String(error);
  }
});

els.repeaterRequest.addEventListener("input", syncActiveRepeaterTab);

els.repeaterResizeHandle.addEventListener("pointerdown", startRepeaterResize);
els.repeaterResizeHandle.addEventListener("keydown", resizeRepeaterWithKeyboard);
els.workspaceResizeHandle.addEventListener("pointerdown", startWorkspaceResize);
els.workspaceResizeHandle.addEventListener("keydown", resizeWorkspaceWithKeyboard);
els.detailResizeHandle.addEventListener("pointerdown", startDetailResize);
els.detailResizeHandle.addEventListener("keydown", resizeDetailWithKeyboard);

for (const tab of els.tabs) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
}

async function setMode(mode) {
  state.mode = mode;
  els.modeSelect.value = mode;
  state.capturing = mode === "capturing";
  els.toggleCapture.textContent = state.capturing ? "Pause" : "Resume";

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

async function startInterceptMode() {
  clearInterceptEditor("Waiting for request");
  await sendRuntimeMessage({ type: "intercept:start", tabId: state.inspectedTabId });

  if (state.interceptPollId) {
    window.clearInterval(state.interceptPollId);
  }
  state.interceptPollId = window.setInterval(pollIntercept, 500);
  await pollIntercept();
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
  els.interceptStatus.textContent = `${result.paused.method} ${result.paused.url}`;
  els.interceptRequest.value = result.paused.rawRequest;
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
  const query = els.searchInput.value.trim().toLowerCase();
  const visibleEntries = state.entries.filter((entry) => {
    const haystack = [
      entry.sequenceId,
      entry.request.method,
      entry.response.status,
      entry.request.url,
      formatHistoryTime(entry.startedDateTime)
    ].join(" ").toLowerCase();
    return haystack.includes(query) && !isHiddenByExtension(entry);
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
    url.className = "url";
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

function renderExtensionFilters() {
  els.extensionFilterList.replaceChildren(...FILTER_EXTENSIONS.map((extension) => {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.hiddenExtensions.has(extension);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.hiddenExtensions.add(extension);
      } else {
        state.hiddenExtensions.delete(extension);
      }
      renderHistory();
    });

    const text = document.createElement("span");
    text.textContent = `.${extension}`;

    label.append(checkbox, text);
    return label;
  }));
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

function showHighlightMenu(clientX, clientY) {
  els.highlightMenu.hidden = false;
  const rect = els.highlightMenu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY, window.innerHeight - rect.height - 8);
  els.highlightMenu.style.left = `${Math.max(8, left)}px`;
  els.highlightMenu.style.top = `${Math.max(8, top)}px`;
}

function hideHighlightMenu() {
  els.highlightMenu.hidden = true;
  state.highlightTargetId = null;
}

function showUrlMenu(clientX, clientY) {
  els.urlMenu.hidden = false;
  const rect = els.urlMenu.getBoundingClientRect();
  const left = Math.min(clientX, window.innerWidth - rect.width - 8);
  const top = Math.min(clientY, window.innerHeight - rect.height - 8);
  els.urlMenu.style.left = `${Math.max(8, left)}px`;
  els.urlMenu.style.top = `${Math.max(8, top)}px`;
}

function hideUrlMenu() {
  els.urlMenu.hidden = true;
  state.urlMenuTargetId = null;
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

async function blockHistoryEntryUrl(url) {
  await sendRuntimeMessage({ type: "block:add", url });
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
    return;
  }

  els.requestText.value = formatRawRequest(entry.request);
  els.responseText.value = formatRawResponse(entry.response);
  els.responseMeta.textContent = `${entry.response.status} ${entry.response.statusText} | ${entry.time} ms`;
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
    return;
  }

  els.repeaterEditors.style.setProperty("--request-pane-size", tab.requestPaneSize || "1fr");
  els.repeaterRequest.value = tab.requestText;
  els.repeaterResponse.value = tab.responseText;
  els.repeaterMeta.textContent = tab.meta;
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

async function sendRuntimeMessage(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || !result.ok) {
    throw new Error(result?.error || "Extension command failed.");
  }
  return result;
}

function clearInterceptEditor(status) {
  state.pausedInterceptId = null;
  els.interceptStatus.textContent = status;
  els.interceptRequest.value = "";
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
    sort: state.sort,
    hiddenExtensions: Array.from(state.hiddenExtensions),
    historyPaneSize: state.historyPaneSize,
    detailRequestPaneSize: state.detailRequestPaneSize,
    historyColumns: state.historyColumns,
    repeaterTabs: state.repeaterTabs,
    activeRepeaterId: state.activeRepeaterId
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `interceptor-project-${timestamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
    state.hiddenExtensions = Array.isArray(project.hiddenExtensions)
      ? new Set(project.hiddenExtensions.filter((extension) => FILTER_EXTENSIONS.includes(extension)))
      : new Set(DEFAULT_HIDDEN_EXTENSIONS);
    state.historyPaneSize = typeof project.historyPaneSize === "string" ? project.historyPaneSize : null;
    state.detailRequestPaneSize = typeof project.detailRequestPaneSize === "string" ? project.detailRequestPaneSize : null;
    state.historyColumns = normalizeProjectHistoryColumns(project.historyColumns);
    state.repeaterTabs = Array.isArray(project.repeaterTabs)
      ? project.repeaterTabs.map(normalizeProjectRepeaterTab)
      : [];
    state.activeRepeaterId = state.repeaterTabs.some((tab) => tab.id === project.activeRepeaterId)
      ? project.activeRepeaterId
      : state.repeaterTabs[0]?.id || null;

    renderHistory();
    renderExtensionFilters();
    applyLayoutSizes();
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
  const firstLine = `${request.method} ${path || "/"} ${request.httpVersion || "HTTP/1.1"}`;
  const headers = {
    Host: url.host,
    ...request.headers
  };

  return `${firstLine}\n${formatHeaders(headers)}\n\n${request.body || ""}`;
}

function formatRawResponse(response) {
  const firstLine = `${response.httpVersion || "HTTP/1.1"} ${response.status} ${response.statusText || ""}`.trim();
  const body = response.encoding === "base64"
    ? `[base64 encoded body]\n\n${response.body || ""}`
    : response.body || "";

  return `${firstLine}\n${formatHeaders(response.headers)}\n\n${body}`;
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

renderExtensionFilters();
applyLayoutSizes();
renderHistory();
renderDetail();
renderRepeater();
