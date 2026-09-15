# Fiello Model Transport Proxy

Fiello Model Transport Proxy runs a loopback proxy inside the VS Code
extension host. It forwards custom language-model requests to one configured
HTTPS endpoint while forcing a fresh HTTP/1.1 TLS connection for every upstream
request.

## Why this proxy exists

Some custom Chat Completions and Responses API connections in VS Code fail
intermittently when the HTTP/2 connection is closed by the upstream gateway.
Typical symptoms include `GOAWAY`, `ERR_HTTP2_PING_FAILED`, and generic network
errors even though the same endpoint remains available over HTTP/1.1.

This extension works around that transport failure by accepting the request on
localhost and forwarding it to the configured HTTPS endpoint over a fresh
HTTP/1.1 connection. It does not change the model request or provide a model
API. The underlying VS Code behavior is tracked in
[microsoft/vscode#335219](https://github.com/microsoft/vscode/issues/335219).

## Features

- Starts with VS Code and stops with the extension host.
- Listens only on `127.0.0.1:43129`.
- Forces upstream ALPN to `http/1.1`.
- Retries transient provider SSE errors with progressive delays before exposing
  a failed response to the model client.
- Streams responses and retains each active request body only in memory while
  retries are possible.
- Keeps API keys and authorization headers in the calling extension's configuration.
- Shows status, uptime, request counts, active requests, and upstream errors in
  a VS Code webview.
- Shares one listener safely across multiple VS Code windows.
- Sends no telemetry.

## Configure

Set the full upstream model endpoint using any of these methods:

1. Click `Fiello Model Transport Proxy` in the VS Code status bar, enter the endpoint, and
   select **Save**.
2. Run **Fiello Model Transport Proxy: Configure Upstream** from the
  Command Palette.
3. Open VS Code Settings and set `customModelHttp1Proxy.upstreamUrl`.

The dashboard and VS Code Settings also expose
`customModelHttp1Proxy.maxProviderRetries`. It accepts `0` through `30` and
defaults to `5`. Retry delays grow from 1 second to a 15-second cap; a provider
`Retry-After` value is honored up to 60 seconds.

The endpoint must:

- use HTTPS;
- include the complete path and query string expected by the model API;
- not contain credentials or a URL fragment.

Example:

```text
https://models.example.com/v1/responses?api-version=2026-01-01
```

Then configure the custom model client to call the local listener. The local
path can mirror the upstream path for readability:

```text
http://127.0.0.1:43129/v1/responses
```

The proxy sends every non-health request to the complete configured upstream
URL. Request headers, including authorization headers, are forwarded after
hop-by-hop headers are removed.

## Status

Click `Fiello Model Transport Proxy` in the status bar or run
**Fiello Model Transport Proxy: Show Status**.

The status view provides:

- runtime state;
- local and upstream endpoints;
- uptime and request counters;
- active request count;
- upstream error count and latest error;
- upstream configuration, VS Code Settings, and restart controls.

The local health endpoint is also available at:

```text
http://127.0.0.1:43129/__health
```

## Install

### Visual Studio Marketplace

After publication, install **Fiello Model Transport Proxy** from the
Extensions view in VS Code.

### VSIX

Download or build the `.vsix`, then use **Extensions: Install from VSIX...**
from the Command Palette.

The command-line equivalent is:

```bash
code --install-extension fiello-model-transport-proxy-0.2.2.vsix
```

## Build

Requirements:

- Node.js 20 or newer;
- VS Code 1.85 or newer.

Run:

```bash
npm test
npm run package
```

`npm run package` creates the standard versioned VSIX installer in the project directory.

## Security

- The listener binds only to IPv4 loopback and is not exposed to the local network.
- Only HTTPS upstream endpoints are accepted.
- User information and credentials are rejected in the configured URL.
- Request bodies are held in memory only for the lifetime of an active request
  and are not logged or persisted. Credentials are not logged or persisted.
- The extension does not read custom model configuration files and does not
  store API keys.
- Every upstream request uses a new connection with HTTP/1.1 ALPN, avoiding
  stale pooled HTTP/2 sessions.

Any local process can connect to a loopback port. Keep secrets in authorization
headers and use the operating system and VS Code security controls appropriate
for your environment.

## Limitations

- One upstream endpoint is supported per VS Code user profile.
- The local listener uses fixed port `43129`.
- This is a transport workaround, not a replacement for an upstream fix in VS
  Code, the calling extension, or the model gateway.
- An in-flight request ends when the VS Code window that owns the listener
  closes. Another open VS Code window takes ownership for subsequent requests.

## Troubleshooting

### `notConfigured`

Set `customModelHttp1Proxy.upstreamUrl` to the complete upstream HTTPS endpoint.

### `blocked`

Another process owns port `43129`. Stop that process, then run
**Fiello Model Transport Proxy: Restart**.

### `502 upstream_request_failed`

Open the status view and inspect **Last error**. Confirm DNS, TLS, firewall,
endpoint path, and gateway availability.

### The custom model still uses HTTP/2

Confirm that its configured URL starts with `http://127.0.0.1:43129/`, then
check that the request counter increases in the status view.

## Related issue

- [microsoft/vscode#335219: custom chat-completions model fails intermittently with HTTP/2 GOAWAY](https://github.com/microsoft/vscode/issues/335219)

## License

MIT
