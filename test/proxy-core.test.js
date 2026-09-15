const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildUpstreamRequestOptions,
  createSseEventObserver,
  forwardHeaders,
  normalizeUpstreamUrl,
  providerRetryDelayMs,
  summarizeProviderError,
} = require("../proxy-core");

test("normalizes a full HTTPS upstream endpoint", () => {
  const upstreamUrl = normalizeUpstreamUrl(" https://models.example.com/v1/responses?api-version=1 ");

  assert.equal(upstreamUrl.origin, "https://models.example.com");
  assert.equal(upstreamUrl.pathname, "/v1/responses");
  assert.equal(upstreamUrl.search, "?api-version=1");
});

test("rejects missing, insecure, credential-bearing, and fragmented endpoints", () => {
  assert.throws(() => normalizeUpstreamUrl(""), /Configure an upstream/);
  assert.throws(() => normalizeUpstreamUrl("http://models.example.com/v1/responses"), /must use HTTPS/);
  assert.throws(() => normalizeUpstreamUrl("https://user:pass@models.example.com/v1/responses"), /credentials/);
  assert.throws(() => normalizeUpstreamUrl("https://models.example.com/v1/responses#fragment"), /fragment/);
});

test("removes hop-by-hop headers", () => {
  assert.deepEqual(
    forwardHeaders({ authorization: "Bearer token", connection: "keep-alive", "content-type": "application/json" }),
    { authorization: "Bearer token", "content-type": "application/json" },
  );
});

test("builds a fresh HTTP/1.1 upstream request for the configured endpoint", () => {
  const options = buildUpstreamRequestOptions(
    normalizeUpstreamUrl("https://models.example.com:8443/v1/responses?api-version=1"),
    {
      method: "POST",
      url: "/ignored/local/path",
      headers: { host: "127.0.0.1:43129", authorization: "Bearer token" },
    },
  );

  assert.equal(options.hostname, "models.example.com");
  assert.equal(options.port, "8443");
  assert.equal(options.path, "/v1/responses?api-version=1");
  assert.equal(options.headers.host, "models.example.com:8443");
  assert.equal(options.headers.authorization, "Bearer token");
  assert.equal(options.agent, false);
  assert.deepEqual(options.ALPNProtocols, ["http/1.1"]);
});

test("observes SSE error events across response chunk boundaries", () => {
  const events = [];
  const observer = createSseEventObserver((event) => events.push(event));

  observer.write(Buffer.from("event: response.created\ndata: {}\n\nevent: err"));
  observer.write(Buffer.from("or\ndata: {\"type\":\"error\",\"error\":{\"code\":\"rate_limit\"}}\n\n"));
  observer.end();

  assert.deepEqual(events, [
    { event: "response.created", data: "{}" },
    { event: "error", data: '{"type":"error","error":{"code":"rate_limit"}}' },
  ]);
});

test("summarizes provider errors without retaining unrelated response data", () => {
  const summary = summarizeProviderError(
    JSON.stringify({
      type: "error",
      error: {
        code: "rate_limit",
        type: "requests",
        message: "Try again later",
        internal_details: "must not be retained",
      },
      response: { prompt: "must not be retained" },
    }),
    { "apim-request-id": "request-123" },
  );

  assert.equal(
    summary,
    "Provider SSE error: code=rate_limit; type=requests; message=Try again later; requestId=request-123",
  );
  assert.doesNotMatch(summary, /prompt|internal_details/);
});

test("uses progressive provider retry delays and honors Retry-After", () => {
  assert.equal(providerRetryDelayMs(1), 1_000);
  assert.equal(providerRetryDelayMs(2), 2_000);
  assert.equal(providerRetryDelayMs(5), 15_000);
  assert.equal(providerRetryDelayMs(30), 15_000);
  assert.equal(providerRetryDelayMs(2, { "retry-after": "9" }), 9_000);
  assert.equal(providerRetryDelayMs(2, { "retry-after": "120" }), 60_000);
});