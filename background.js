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

  const session = interceptSessions.get(source.tabId);
  if (!session || !session.enabled) {
    continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  if (session.paused) {
    continuePausedRequest(source.tabId, params.requestId);
    return;
  }

  session.paused = {
    requestId: params.requestId,
    request: params.request,
    resourceType: params.resourceType,
    createdAt: Date.now()
  };
});

chrome.debugger.onDetach.addListener((source) => {
  interceptSessions.delete(source.tabId);
});

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

  if (message.type === "intercept:start") {
    await startIntercept(message.tabId);
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
    await forwardIntercept(message.tabId, message.rawRequest);
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

function nextRuleId(rules) {
  return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
}

function exactUrlRegex(url) {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

async function startIntercept(tabId) {
  const target = debuggerTarget(tabId);
  let session = interceptSessions.get(tabId);

  if (!session) {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    session = { enabled: true, attached: true, paused: null };
    interceptSessions.set(tabId, session);
  }

  session.enabled = true;
  await chrome.debugger.sendCommand(target, "Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }]
  });
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
    rawRequest: formatPausedRequest(paused.request),
    url: paused.request.url,
    method: paused.request.method,
    resourceType: paused.resourceType
  };
}

async function forwardIntercept(tabId, rawRequest) {
  const session = interceptSessions.get(tabId);
  if (!session?.paused) {
    return;
  }

  const paused = session.paused;
  const parsed = parseRawRequest(rawRequest, paused.request.url);
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
