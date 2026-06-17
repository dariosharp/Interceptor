const DEBUGGER_VERSION = "1.3";
const blockedUrls = new Map();
const interceptSessions = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Fetch.requestPaused") {
    return;
  }

  handlePausedRequest(source, params);
});

chrome.debugger.onDetach.addListener((source) => {
  interceptSessions.delete(source.tabId);
});

async function handlePausedRequest(source, params) {
  const session = interceptSessions.get(source.tabId);
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

async function startIntercept(tabId, urls, enabled = true) {
  const target = debuggerTarget(tabId);
  let session = interceptSessions.get(tabId);

  if (!session) {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    session = { enabled, attached: true, paused: null, urls: new Set(urls || []) };
    interceptSessions.set(tabId, session);
  }

  session.enabled = enabled;
  session.urls = new Set(urls || []);
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
  await chrome.debugger.detach(debuggerTarget(tabId)).catch(() => {});
  interceptSessions.delete(tabId);
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

  const startedAt = Date.now();
  const fetchResponse = await fetch(request.url, options);
  const body = await fetchResponse.text();
  const durationMs = Date.now() - startedAt;

  const responseHeaders = {};
  fetchResponse.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });

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
