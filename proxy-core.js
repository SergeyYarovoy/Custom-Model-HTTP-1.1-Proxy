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
  forwardHeaders,
  normalizeUpstreamUrl,
};