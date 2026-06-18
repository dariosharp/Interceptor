const DEBUGGER_VERSION = "1.3";
const blockedUrls = new Map();
const interceptSessions = new Map();
const debuggerRepeaterSessions = new Map();
const webRequestRepeaterSessions = new Map();
let nextWebRequestRepeaterId = 1;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  handleDebuggerRepeaterEvent(source, method, params);

  if (method !== "Fetch.requestPaused") {
    return;
  }

  if (handleDebuggerRepeaterPausedResponse(source, params)) {
    return;
  }

  handlePausedRequest(source, params);
});

chrome.debugger.onDetach.addListener((source) => {
  interceptSessions.delete(source.tabId);
  rejectDebuggerRepeater(source.tabId, new Error("Debugger detached before the repeater response completed."));
});

if (chrome.webRequest) {
  chrome.webRequest.onHeadersReceived.addListener(
    handleWebRequestRepeaterResponse,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
  chrome.webRequest.onBeforeRedirect.addListener(
    handleWebRequestRepeaterResponse,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
}

async function handlePausedRequest(source, params) {
  const session = interceptSessions.get(source.tabId);
  if (shouldBypassInterceptForRepeater(source.tabId, params.request.url)) {
    await continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  if (!session || !session.enabled) {
    await continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  if (!shouldInterceptUrl(session, params.request.url)) {
    await continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  if (session.paused) {
    await continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  const responseBody = params.responseStatusCode
    ? await getResponseBody(source.tabId, params.requestId)
    : null;

  session.paused = {
    requestId: params.requestId,
    stage: params.responseStatusCode ? "response" : "request",
    request: params.request,
    responseStatusCode: params.responseStatusCode,
    responseStatusText: params.responseStatusText,
    responseHeaders: params.responseHeaders || [],
    responseBody,
    resourceType: params.resourceType,
    createdAt: Date.now()
  };
}

async function handleMessage(message) {
  if (!message || !message.type) {
    return {};
  }

  if (message.type === "repeater:send") {
    return { response: await sendRepeaterRequest(message.request) };
  }

  if (message.type === "repeater:sendDebugger") {
    return { response: await sendDebuggerRepeaterRequest(message.tabId, message.request) };
  }

  if (message.type === "debugger:attach") {
    await ensureDebuggerAttached(message.tabId, true);
    return {};
  }

  if (message.type === "debugger:detach") {
    await detachDebuggerSession(message.tabId);
    return {};
  }

  if (message.type === "block:add") {
    await blockRequestUrl(message.url);
    return {};
  }

  if (message.type === "block:remove") {
    await unblockRequestUrl(message.url);
    return {};
  }

  if (message.type === "intercept:start") {
    await startIntercept(message.tabId, message.urls, message.enabled);
    return {};
  }

  if (message.type === "intercept:setEnabled") {
    await setInterceptEnabled(message.tabId, message.enabled);
    return {};
  }

  if (message.type === "intercept:setUrls") {
    setInterceptUrls(message.tabId, message.urls);
    return {};
  }

  if (message.type === "intercept:stop") {
    await stopIntercept(message.tabId);
    return {};
  }

  if (message.type === "intercept:getPaused") {
    return { paused: getPausedIntercept(message.tabId) };
  }

  if (message.type === "intercept:forward") {
    await forwardIntercept(message.tabId, message.rawMessage || message.rawRequest);
    return {};
  }

  if (message.type === "intercept:drop") {
    await dropIntercept(message.tabId);
    return {};
  }

  throw new Error(`Unknown message type: ${message.type}`);
}

async function blockRequestUrl(url) {
  if (!url) {
    throw new Error("URL is required.");
  }

  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const existing = blockedUrls.get(url) || rules.find((rule) => rule.condition.regexFilter === exactUrlRegex(url));
  const id = existing?.id || nextRuleId(rules);
  blockedUrls.set(url, { id, url });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: "block" },
      condition: {
        regexFilter: exactUrlRegex(url),
        resourceTypes: [
          "main_frame",
          "sub_frame",
          "stylesheet",
          "script",
          "image",
          "font",
          "object",
          "xmlhttprequest",
          "ping",
          "csp_report",
          "media",
          "websocket",
          "webtransport",
          "webbundle",
          "other"
        ]
      }
    }]
  });
}

async function unblockRequestUrl(url) {
  if (!url) {
    throw new Error("URL is required.");
  }

  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = blockedUrls.get(url) || rules.find((candidate) => candidate.condition.regexFilter === exactUrlRegex(url));
  if (!rule) {
    return;
  }

  blockedUrls.delete(url);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [rule.id]
  });
}

function nextRuleId(rules) {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

function exactUrlRegex(url) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

async function ensureDebuggerAttached(tabId, keepAttached = false) {
  const target = debuggerTarget(tabId);
  let session = interceptSessions.get(Number(tabId));

  if (!session) {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    session = {
      enabled: false,
      attached: true,
      keepAttached: Boolean(keepAttached),
      fetchMode: null,
      paused: null,
      urls: new Set()
    };
    interceptSessions.set(Number(tabId), session);
  }

  session.keepAttached = session.keepAttached || Boolean(keepAttached);
  session.attached = true;
  return session;
}

async function detachDebuggerSession(tabId) {
  tabId = Number(tabId);
  const session = interceptSessions.get(tabId);
  if (!session) {
    return;
  }

  if (session.paused) {
    await continuePausedRequest(tabId, session.paused.requestId);
  }

  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.disable").catch(() => {});
  await chrome.debugger.detach(debuggerTarget(tabId)).catch(() => {});
  interceptSessions.delete(tabId);
}

async function startIntercept(tabId, urls, enabled = true) {
  const target = debuggerTarget(tabId);
  const session = await ensureDebuggerAttached(tabId, true);

  session.enabled = enabled;
  session.urls = new Set(urls || []);
  session.fetchMode = "intercept";
  await chrome.debugger.sendCommand(target, "Fetch.enable", {
    patterns: [
      { urlPattern: "*", requestStage: "Request" },
      { urlPattern: "*", requestStage: "Response" }
    ]
  });
}

async function setInterceptEnabled(tabId, enabled) {
  const session = interceptSessions.get(tabId);
  if (!session) {
    return;
  }

  session.enabled = Boolean(enabled);
  if (!session.enabled && session.paused) {
    const requestId = session.paused.requestId;
    session.paused = null;
    await continuePausedRequest(tabId, requestId);
  }
}

function setInterceptUrls(tabId, urls) {
  const session = interceptSessions.get(tabId);
  if (session) {
    session.urls = new Set(urls || []);
  }
}

function shouldInterceptUrl(session, url) {
  return !session.urls?.size || session.urls.has(url);
}

async function stopIntercept(tabId) {
  const session = interceptSessions.get(tabId);
  if (!session) {
    return;
  }

  if (session.paused) {
    await continuePausedRequest(tabId, session.paused.requestId);
  }

  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.disable").catch(() => {});
  session.enabled = false;
  session.paused = null;
  session.fetchMode = null;
  session.urls = new Set();

  if (!session.keepAttached) {
    await chrome.debugger.detach(debuggerTarget(tabId)).catch(() => {});
    interceptSessions.delete(tabId);
  }
}

function getPausedIntercept(tabId) {
  const paused = interceptSessions.get(tabId)?.paused;
  if (!paused) {
    return null;
  }

  return {
    id: paused.requestId,
    stage: paused.stage,
    rawMessage: paused.stage === "response" ? formatPausedResponse(paused) : formatPausedRequest(paused.request),
    url: paused.request.url,
    method: paused.request.method,
    resourceType: paused.resourceType
  };
}

async function forwardIntercept(tabId, rawMessage) {
  const session = interceptSessions.get(tabId);
  if (!session?.paused) {
    return;
  }

  const paused = session.paused;
  if (paused.stage === "response") {
    await fulfillPausedResponse(tabId, paused, rawMessage);
    session.paused = null;
    return;
  }

  const parsed = parseRawRequest(rawMessage, paused.request.url);
  const params = {
    requestId: paused.requestId,
    url: parsed.url,
    method: parsed.method,
    headers: Object.entries(parsed.headers).map(([name, value]) => ({ name, value }))
  };

  if (!["GET", "HEAD"].includes(parsed.method) && parsed.body) {
    params.postData = btoa(unescape(encodeURIComponent(parsed.body)));
  }

  session.paused = null;
  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.continueRequest", params);
}

async function fulfillPausedResponse(tabId, paused, rawResponse) {
  const parsed = parseRawResponse(rawResponse);
  const params = {
    requestId: paused.requestId,
    responseCode: parsed.status,
    responseHeaders: Object.entries(parsed.headers).map(([name, value]) => ({ name, value })),
    body: btoa(unescape(encodeURIComponent(parsed.body)))
  };

  const responsePhrase = sanitizeStatusText(parsed.statusText);
  if (responsePhrase) {
    params.responsePhrase = responsePhrase;
  }

  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.fulfillRequest", params);
}

async function dropIntercept(tabId) {
  const session = interceptSessions.get(tabId);
  if (!session?.paused) {
    return;
  }

  const requestId = session.paused.requestId;
  session.paused = null;
  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.failRequest", {
    requestId,
    errorReason: "BlockedByClient"
  });
}

async function continuePausedRequest(tabId, requestId) {
  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.continueRequest", { requestId }).catch(() => {});
}

function debuggerTarget(tabId) {
  return { tabId: Number(tabId) };
}

function formatPausedRequest(request) {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const headers = {
    Host: url.host
  };

  for (const [name, value] of headerEntries(request.headers)) {
    if (!isForbiddenRequestHeader(name)) {
      headers[name] = value;
    }
  }

  return `${request.method} ${path || "/"} HTTP/1.1\n${formatHeaders(headers)}\n\n${request.postData || ""}`;
}

function formatPausedResponse(paused) {
  const headers = {};
  for (const header of paused.responseHeaders || []) {
    headers[header.name] = header.value;
  }
  const body = decodeResponseBody(paused.responseBody);
  const status = paused.responseStatusCode || 200;
  const statusText = paused.responseStatusText || "";
  return `HTTP/1.1 ${status} ${statusText}`.trim() + `\n${formatHeaders(headers)}\n\n${body}`;
}

async function getResponseBody(tabId, requestId) {
  try {
    return await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.getResponseBody", { requestId });
  } catch (_error) {
    return { body: "", base64Encoded: false };
  }
}

function decodeResponseBody(responseBody) {
  if (!responseBody?.body) {
    return "";
  }
  if (!responseBody.base64Encoded) {
    return responseBody.body;
  }
  try {
    return decodeURIComponent(escape(atob(responseBody.body)));
  } catch (_error) {
    return responseBody.body;
  }
}

async function sendDebuggerRepeaterRequest(tabId, request) {
  tabId = Number(tabId);
  if (!tabId) {
    throw new Error("Inspected tab is required for debugger repeater.");
  }
  if (!request || !request.url) {
    throw new Error("Request URL is required.");
  }
  if (debuggerRepeaterSessions.has(tabId)) {
    throw new Error("Another debugger repeater request is already running.");
  }

  const target = debuggerTarget(tabId);
  let debuggerSession = interceptSessions.get(tabId);
  let attachedHere = false;
  let fetchEnabledHere = false;
  let timeoutId = null;
  let evaluationPromise = null;
  const headers = prepareRepeaterHeaders(request.headers);
  const startedAt = Date.now();

  const sessionPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      rejectDebuggerRepeater(tabId, new Error("Debugger repeater timed out."));
    }, 30000);

    debuggerRepeaterSessions.set(tabId, {
      request,
      method: String(request.method || "GET").toUpperCase(),
      initialUrl: request.url,
      startedAt,
      requestIds: new Set(),
      redirectResponses: [],
      finalResponse: null,
      resolve,
      reject,
      timeoutId
    });
  });
  sessionPromise.catch(() => {});

  try {
    attachedHere = !debuggerSession?.attached;
    debuggerSession = await ensureDebuggerAttached(tabId, true);

    await chrome.debugger.sendCommand(target, "Network.enable");
    if (debuggerSession.fetchMode !== "intercept") {
      await chrome.debugger.sendCommand(target, "Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }]
      });
      debuggerSession.fetchMode = "repeater";
      fetchEnabledHere = true;
    }

    evaluationPromise = chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(${debuggerRepeaterFetchSource()})(${JSON.stringify({
        request: {
          method: request.method || "GET",
          url: request.url,
          headers: headers.headers,
          body: request.body || ""
        }
      })})`,
      awaitPromise: true,
      returnByValue: true
    });
    evaluationPromise.catch((error) => {
      const session = debuggerRepeaterSessions.get(tabId);
      if (session && !session.redirectResponses.length && !session.finalResponse) {
        rejectDebuggerRepeater(tabId, error);
      }
    });

    const response = await sessionPromise;
    await evaluationPromise.catch(() => {});
    response.skippedHeaders = headers.skippedHeaders;
    return response;
  } catch (error) {
    rejectDebuggerRepeater(tabId, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    debuggerRepeaterSessions.delete(tabId);
    if (fetchEnabledHere) {
      await chrome.debugger.sendCommand(target, "Fetch.disable").catch(() => {});
      const session = interceptSessions.get(tabId);
      if (session?.fetchMode === "repeater") {
        session.fetchMode = null;
      }
    }
    await chrome.debugger.sendCommand(target, "Network.disable").catch(() => {});
    const session = interceptSessions.get(tabId);
    if (attachedHere && !session?.keepAttached) {
      await chrome.debugger.detach(target).catch(() => {});
      interceptSessions.delete(tabId);
    }
  }
}

function handleDebuggerRepeaterEvent(source, method, params) {
  const session = debuggerRepeaterSessions.get(source.tabId);
  if (!session) {
    return;
  }

  if (method === "Network.requestWillBeSent") {
    handleDebuggerRepeaterRequest(session, params);
    return;
  }

  if (!session.requestIds.has(params?.requestId)) {
    return;
  }

  if (method === "Network.responseReceived") {
    session.finalResponse = params.response;
    return;
  }

  if (method === "Network.loadingFinished") {
    resolveDebuggerRepeater(source.tabId, params.requestId);
    return;
  }

  if (method === "Network.loadingFailed") {
    if (session.redirectResponses.length || session.finalResponse) {
      resolveDebuggerRepeater(source.tabId, params.requestId);
    } else {
      rejectDebuggerRepeater(source.tabId, new Error(params.errorText || "Debugger repeater request failed."));
    }
  }
}

function handleDebuggerRepeaterPausedResponse(source, params) {
  const session = debuggerRepeaterSessions.get(source.tabId);
  if (!session || !params.responseStatusCode) {
    return false;
  }

  const method = String(params.request?.method || "").toUpperCase();
  if (params.request?.url !== session.initialUrl || method !== session.method) {
    return false;
  }

  session.requestIds.add(params.networkId || params.requestId);
  resolveDebuggerRepeaterPausedResponse(source.tabId, params);
  return true;
}

async function resolveDebuggerRepeaterPausedResponse(tabId, params) {
  const session = debuggerRepeaterSessions.get(tabId);
  if (!session) {
    return;
  }

  const headers = {};
  for (const header of params.responseHeaders || []) {
    headers[header.name] = header.value;
  }

  const responseBody = await getResponseBody(tabId, params.requestId);
  clearTimeout(session.timeoutId);
  debuggerRepeaterSessions.delete(tabId);
  session.resolve({
    url: params.request.url,
    status: params.responseStatusCode,
    statusText: params.responseStatusText || "",
    httpVersion: "HTTP/1.1",
    headers,
    body: decodeResponseBody(responseBody),
    durationMs: Date.now() - session.startedAt,
    redirectChain: []
  });

  await chrome.debugger.sendCommand(debuggerTarget(tabId), "Fetch.failRequest", {
    requestId: params.requestId,
    errorReason: "Aborted"
  }).catch(() => {});
}

function handleDebuggerRepeaterRequest(session, params) {
  const eventMethod = String(params.request?.method || "").toUpperCase();
  const isInitialRequest = params.request?.url === session.initialUrl && eventMethod === session.method;
  if (isInitialRequest || session.requestIds.has(params.requestId)) {
    session.requestIds.add(params.requestId);
  }

  if (session.requestIds.has(params.requestId) && params.redirectResponse) {
    session.redirectResponses.push(params.redirectResponse);
  }
}

async function resolveDebuggerRepeater(tabId, requestId) {
  const session = debuggerRepeaterSessions.get(tabId);
  if (!session) {
    return;
  }

  try {
    const selectedResponse = session.redirectResponses[0] || session.finalResponse;
    if (!selectedResponse) {
      throw new Error("Debugger repeater did not capture a response.");
    }

    const isRedirectResponse = session.redirectResponses.includes(selectedResponse);
    const responseBody = isRedirectResponse
      ? { body: "", base64Encoded: false }
      : await getNetworkResponseBody(tabId, requestId);

    clearTimeout(session.timeoutId);
    debuggerRepeaterSessions.delete(tabId);
    session.resolve({
      url: selectedResponse.url,
      status: selectedResponse.status,
      statusText: selectedResponse.statusText || "",
      httpVersion: selectedResponse.protocol || "HTTP/1.1",
      headers: selectedResponse.headers || {},
      body: decodeResponseBody(responseBody),
      durationMs: Date.now() - session.startedAt,
      redirectChain: session.redirectResponses.map((response) => ({
        url: response.url,
        status: response.status,
        statusText: response.statusText || "",
        httpVersion: response.protocol || "HTTP/1.1",
        headers: response.headers || {}
      }))
    });
  } catch (error) {
    rejectDebuggerRepeater(tabId, error);
  }
}

function rejectDebuggerRepeater(tabId, error) {
  const session = debuggerRepeaterSessions.get(tabId);
  if (!session) {
    return;
  }
  clearTimeout(session.timeoutId);
  debuggerRepeaterSessions.delete(tabId);
  session.reject(error);
}

async function getNetworkResponseBody(tabId, requestId) {
  try {
    return await chrome.debugger.sendCommand(debuggerTarget(tabId), "Network.getResponseBody", { requestId });
  } catch (_error) {
    return { body: "", base64Encoded: false };
  }
}

function shouldBypassInterceptForRepeater(tabId, url) {
  const session = debuggerRepeaterSessions.get(tabId);
  return Boolean(session && (url === session.initialUrl || session.requestIds.size));
}

function prepareRepeaterHeaders(rawHeaders) {
  const headers = {};
  const skippedHeaders = [];
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    if (isForbiddenRequestHeader(name) || name.toLowerCase() === "host") {
      skippedHeaders.push(name);
      continue;
    }
    headers[name] = value;
  }
  return { headers, skippedHeaders };
}

function debuggerRepeaterFetchSource() {
  return String(async function debuggerRepeaterFetch(payload) {
    const request = payload.request;
    const options = {
      method: request.method || "GET",
      headers: request.headers || {},
      credentials: "include",
      redirect: "follow",
      cache: "no-store"
    };

    if (!["GET", "HEAD"].includes(options.method.toUpperCase()) && request.body) {
      options.body = request.body;
    }

    const response = await fetch(request.url, options);
    await response.text().catch(() => "");
    return true;
  });
}

async function sendRepeaterRequest(request) {
  if (!request || !request.url) {
    throw new Error("Request URL is required.");
  }

  const headers = new Headers();
  const skippedHeaders = [];
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (isForbiddenRequestHeader(name)) {
      skippedHeaders.push(name);
      continue;
    }
    headers.set(name, value);
  }

  const options = {
    method: request.method || "GET",
    headers,
    redirect: "manual",
    credentials: "include",
    cache: "no-store"
  };

  if (!["GET", "HEAD"].includes(options.method.toUpperCase()) && request.body) {
    options.body = request.body;
  }

  const captureId = startWebRequestRepeaterCapture(request);
  const startedAt = Date.now();
  let fetchResponse;
  let body = "";
  let durationMs = 0;
  try {
    fetchResponse = await fetch(request.url, options);
    body = await fetchResponse.text();
    durationMs = Date.now() - startedAt;
  } finally {
    stopWebRequestRepeaterCapture(captureId);
  }

  const responseHeaders = {};
  fetchResponse.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });

  const capturedResponse = getWebRequestRepeaterCapture(captureId);
  if (capturedResponse && (fetchResponse.status === 0 || isRedirectStatus(capturedResponse.status))) {
    return {
      ...capturedResponse,
      body: isRedirectStatus(capturedResponse.status) ? "" : body,
      durationMs,
      skippedHeaders
    };
  }

  return {
    url: fetchResponse.url,
    status: fetchResponse.status,
    statusText: fetchResponse.statusText,
    headers: responseHeaders,
    body,
    durationMs,
    skippedHeaders
  };
}

function startWebRequestRepeaterCapture(request) {
  const id = nextWebRequestRepeaterId++;
  webRequestRepeaterSessions.set(id, {
    method: String(request.method || "GET").toUpperCase(),
    url: request.url,
    startedAt: Date.now(),
    response: null
  });
  return id;
}

function stopWebRequestRepeaterCapture(id) {
  const session = webRequestRepeaterSessions.get(id);
  if (session) {
    session.stoppedAt = Date.now();
  }
}

function getWebRequestRepeaterCapture(id) {
  const session = webRequestRepeaterSessions.get(id);
  const response = session?.response || null;
  webRequestRepeaterSessions.delete(id);
  return response;
}

function handleWebRequestRepeaterResponse(details) {
  for (const session of webRequestRepeaterSessions.values()) {
    if (session.response || details.url !== session.url || details.method !== session.method) {
      continue;
    }
    if (Date.now() - session.startedAt > 30000) {
      continue;
    }

    session.response = {
      url: details.url,
      status: details.statusCode || 0,
      statusText: statusTextFromStatusLine(details.statusLine),
      httpVersion: httpVersionFromStatusLine(details.statusLine),
      headers: headersArrayToObject(details.responseHeaders),
      body: ""
    };
  }
}

function headersArrayToObject(headers) {
  const result = {};
  for (const header of headers || []) {
    if (!header.name) {
      continue;
    }
    result[header.name] = header.value || "";
  }
  return result;
}

function statusTextFromStatusLine(statusLine) {
  const match = String(statusLine || "").match(/^\S+\s+\d{3}\s*(.*)$/);
  return match ? match[1].trim() : "";
}

function httpVersionFromStatusLine(statusLine) {
  const match = String(statusLine || "").match(/^(HTTP\/\d(?:\.\d)?)/i);
  return match ? match[1].toUpperCase() : "HTTP/1.1";
}

function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

function formatHeaders(headers) {
  return Object.entries(headers || {})
    .filter(([name]) => !isForbiddenRequestHeader(name) || name.toLowerCase() === "host")
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function headerEntries(headers) {
  if (Array.isArray(headers)) {
    return headers.map((header) => [header.name, header.value]);
  }
  return Object.entries(headers || {});
}

function parseRawRequest(rawText, baseUrl) {
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
  const headers = {};
  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`Invalid header: ${line}`);
    }
    const name = line.slice(0, colon).trim();
    if (!isForbiddenRequestHeader(name)) {
      headers[name] = line.slice(colon + 1).trim();
    }
  }

  const host = findHeader(headers, "host");
  const base = new URL(baseUrl);
  const url = target.startsWith("http://") || target.startsWith("https://")
    ? target
    : `${base.protocol}//${host || base.host}${target.startsWith("/") ? target : `/${target}`}`;

  deleteHeader(headers, "host");

  return {
    method: method.toUpperCase(),
    url,
    headers,
    body
  };
}

function parseRawResponse(rawText) {
  const normalized = rawText.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const head = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const body = separator >= 0 ? normalized.slice(separator + 2) : "";
  const lines = head.split("\n").filter(Boolean);
  const statusLine = lines.shift();

  if (!statusLine) {
    throw new Error("Response status line is required.");
  }

  const match = statusLine.match(/^HTTP\/\S+\s+(\d{3})(?:\s+(.*))?$/i);
  if (!match) {
    throw new Error("Response status line must look like: HTTP/1.1 200 OK");
  }

  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new Error(`Invalid header: ${line}`);
    }
    const name = line.slice(0, colon).trim();
    if (!isForbiddenResponseHeader(name)) {
      headers[name] = line.slice(colon + 1).trim();
    }
  }

  return {
    status: Number(match[1]),
    statusText: sanitizeStatusText(match[2] || ""),
    headers,
    body
  };
}

function sanitizeStatusText(value) {
  return String(value || "")
    .replace(/[\r\n]/g, " ")
    .replace(/[^\t\x20-\x7e]/g, "")
    .trim();
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

function isForbiddenRequestHeader(name) {
  const normalized = name.toLowerCase();
  if (normalized.startsWith(":")) {
    return true;
  }
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
    "keep-alive",
    "origin",
    "permissions-policy",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via"
  ].includes(normalized) || normalized.startsWith("proxy-") || normalized.startsWith("sec-");
}

function isForbiddenResponseHeader(name) {
  const normalized = name.toLowerCase();
  return [
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
  ].includes(normalized);
}
