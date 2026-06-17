const MAX_HISTORY = 500;

const state = {
  capturing: true,
  entries: [],
  selectedId: null,
  activeView: "detail",
  repeaterTabs: [],
  activeRepeaterId: null
};

const els = {
  captureState: document.querySelector("#captureState"),
  downloadProject: document.querySelector("#downloadProject"),
  uploadProject: document.querySelector("#uploadProject"),
  projectFile: document.querySelector("#projectFile"),
  toggleCapture: document.querySelector("#toggleCapture"),
  clearHistory: document.querySelector("#clearHistory"),
  searchInput: document.querySelector("#searchInput"),
  requestList: document.querySelector("#requestList"),
  requestText: document.querySelector("#requestText"),
  responseText: document.querySelector("#responseText"),
  responseMeta: document.querySelector("#responseMeta"),
  sendToRepeater: document.querySelector("#sendToRepeater"),
  repeaterTabList: document.querySelector("#repeaterTabList"),
  emptyRepeater: document.querySelector("#emptyRepeater"),
  repeaterEditors: document.querySelector("#repeaterEditors"),
  repeaterRequest: document.querySelector("#repeaterRequest"),
  repeaterResponse: document.querySelector("#repeaterResponse"),
  repeaterMeta: document.querySelector("#repeaterMeta"),
  sendRequest: document.querySelector("#sendRequest"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  views: {
    detail: document.querySelector("#detailView"),
    repeater: document.querySelector("#repeaterView")
  }
};

chrome.devtools.network.onRequestFinished.addListener((harEntry) => {
  if (!state.capturing) {
    return;
  }

  harEntry.getContent((content, encoding) => {
    const entry = normalizeHarEntry(harEntry, content, encoding);
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
  state.capturing = !state.capturing;
  els.captureState.textContent = state.capturing ? "Capturing" : "Paused";
  els.toggleCapture.textContent = state.capturing ? "Pause" : "Resume";
});

els.clearHistory.addEventListener("click", () => {
  state.entries = [];
  state.selectedId = null;
  renderHistory();
  renderDetail();
});

els.searchInput.addEventListener("input", renderHistory);

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

els.repeaterRequest.addEventListener("input", syncActiveRepeaterTab);

for (const tab of els.tabs) {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
}

function normalizeHarEntry(harEntry, content, encoding) {
  const requestHeaders = headersToObject(harEntry.request.headers);
  const responseHeaders = headersToObject(harEntry.response.headers);

  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
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
    result[header.name] = header.value;
  }
  return result;
}

function renderHistory() {
  const query = els.searchInput.value.trim().toLowerCase();
  const visibleEntries = state.entries.filter((entry) => {
    const haystack = `${entry.request.method} ${entry.response.status} ${entry.request.url}`.toLowerCase();
    return haystack.includes(query);
  });

  els.requestList.replaceChildren(...visibleEntries.map((entry) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `request-row${entry.id === state.selectedId ? " active" : ""}`;
    button.addEventListener("click", () => {
      state.selectedId = entry.id;
      renderHistory();
      renderDetail();
    });

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

    button.append(method, status, url);
    item.append(button);
    return item;
  }));
}

function renderDetail() {
  const entry = selectedEntry();
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

    const button = document.createElement("button");
    button.type = "button";
    button.className = "repeater-tab-main";
    button.title = tab.title;
    button.addEventListener("click", () => {
      syncActiveRepeaterTab();
      state.activeRepeaterId = tab.id;
      renderRepeater();
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

    state.entries = Array.isArray(project.history) ? project.history.slice(0, MAX_HISTORY) : [];
    state.selectedId = state.entries.some((entry) => entry.id === project.selectedId)
      ? project.selectedId
      : state.entries[0]?.id || null;
    state.repeaterTabs = Array.isArray(project.repeaterTabs)
      ? project.repeaterTabs.map(normalizeProjectRepeaterTab)
      : [];
    state.activeRepeaterId = state.repeaterTabs.some((tab) => tab.id === project.activeRepeaterId)
      ? project.activeRepeaterId
      : state.repeaterTabs[0]?.id || null;

    renderHistory();
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
    createdAt: typeof tab.createdAt === "string" ? tab.createdAt : new Date().toISOString(),
    updatedAt: typeof tab.updatedAt === "string" ? tab.updatedAt : new Date().toISOString()
  };
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

renderHistory();
renderDetail();
renderRepeater();
