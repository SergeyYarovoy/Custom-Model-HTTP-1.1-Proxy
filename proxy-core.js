const { StringDecoder } = require("node:string_decoder");

const MAX_SSE_EVENT_BYTES = 64 * 1024;
const MAX_ERROR_FIELD_LENGTH = 500;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function parseSseEvent(block) {
  let event = "message";
  const data = [];

  for (const line of block.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  return { event, data: data.join("\n") };
}

function createSseEventObserver(onEvent) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discardingOversizedEvent = false;

  function emitCompleteEvents() {
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (discardingOversizedEvent) {
        discardingOversizedEvent = false;
        continue;
      }
      if (block !== "") {
        onEvent(parseSseEvent(block));
      }
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES) {
      buffer = "";
      discardingOversizedEvent = true;
    }
  }

  return {
    write(chunk) {
      buffer += decoder.write(chunk);
      emitCompleteEvents();
    },
    end() {
      buffer += decoder.end();
      if (!discardingOversizedEvent && buffer !== "") {
        onEvent(parseSseEvent(buffer));
      }
      buffer = "";
    },
  };
}

function safeErrorField(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_FIELD_LENGTH) || undefined;
}

function providerErrorPayload(data) {
  try {
    const payload = JSON.parse(data);
    const error = payload && typeof payload === "object" && payload.error && typeof payload.error === "object"
      ? payload.error
      : payload;
    return { payload, error };
  } catch {
    return { payload: {}, error: {} };
  }
}

function summarizeProviderError(data, headers = {}) {
  const { payload, error } = providerErrorPayload(data);
  const fields = [
    ["code", safeErrorField(error?.code)],
    ["type", safeErrorField(error?.type ?? payload?.type)],
    ["message", safeErrorField(error?.message)],
    ["requestId", safeErrorField(headers["x-request-id"] ?? headers["apim-request-id"] ?? headers["request-id"])],
  ];
  const details = fields.filter(([, value]) => value).map(([name, value]) => `${name}=${value}`);
  return details.length > 0 ? `Provider SSE error: ${details.join("; ")}` : "Provider SSE error";
}

function isTransientProviderError(data) {
  const { payload, error } = providerErrorPayload(data);
  const classification = [error?.code, error?.type, payload?.type]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ")
    .toLowerCase();
  return /(429|rate.?limit|capacity|overload|server.?error|internal.?error|service.?unavailable|temporar|timeout)/.test(
    classification,
  );
}

function providerRetryDelayMs(retryNumber, headers = {}) {
  const progressiveDelay = Math.min(1_000 * (2 ** Math.max(0, retryNumber - 1)), 15_000);
  const retryAfter = Array.isArray(headers["retry-after"])
    ? headers["retry-after"][0]
    : headers["retry-after"];
  let retryAfterDelay = 0;

  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      retryAfterDelay = seconds * 1_000;
    } else {
      const retryAt = Date.parse(String(retryAfter));
      if (Number.isFinite(retryAt)) {
        retryAfterDelay = Math.max(0, retryAt - Date.now());
      }
    }
  }

  return Math.min(Math.max(progressiveDelay, retryAfterDelay), 60_000);
}

function normalizeUpstreamUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Configure an upstream HTTPS endpoint URL");
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(value.trim());
  } catch {
    throw new Error("The upstream endpoint is not a valid URL");
  }

  if (upstreamUrl.protocol !== "https:") {
    throw new Error("The upstream endpoint must use HTTPS");
  }
  if (upstreamUrl.username || upstreamUrl.password) {
    throw new Error("The upstream endpoint must not contain credentials");
  }
  if (upstreamUrl.hash) {
    throw new Error("The upstream endpoint must not contain a URL fragment");
  }

  return upstreamUrl;
}

function forwardHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase())),
  );
}

function buildUpstreamRequestOptions(upstreamUrl, request) {
  return {
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 443,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers: {
      ...forwardHeaders(request.headers),
      host: upstreamUrl.host,
    },
    agent: false,
    ALPNProtocols: ["http/1.1"],
  };
}

module.exports = {
  buildUpstreamRequestOptions,
  createSseEventObserver,
  forwardHeaders,
  isTransientProviderError,
  normalizeUpstreamUrl,
  providerRetryDelayMs,
  summarizeProviderError,
};