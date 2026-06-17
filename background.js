chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "repeater:send") {
    return false;
  }

  sendRepeaterRequest(message.request)
    .then((response) => sendResponse({ ok: true, response }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

  return true;
});

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

function isForbiddenRequestHeader(name) {
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
  ].includes(normalized) || normalized.startsWith("proxy-") || normalized.startsWith("sec-");
}
