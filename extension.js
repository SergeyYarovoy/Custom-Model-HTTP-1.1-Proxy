const http = require("node:http");
const https = require("node:https");
const vscode = require("vscode");
const {
  buildUpstreamRequestOptions,
  createSseEventObserver,
  forwardHeaders,
  isTransientProviderError,
  normalizeUpstreamUrl,
  providerRetryDelayMs,
  summarizeProviderError,
} = require("./proxy-core");

const CONFIGURATION_SECTION = "customModelHttp1Proxy";
const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 43129;
const MAX_PROVIDER_RETRIES = 30;
const SERVICE_NAME = "vscode-custom-model-http1-proxy";

let server;
let statusBar;
let statusPanel;
let monitorTimer;
let mode = "starting";
let upstreamUrl;
let lastError = null;
let startedAt = null;
let requests = 0;
let activeRequests = 0;
let upstreamErrors = 0;
let providerErrors = 0;
let providerRetries = 0;

function configuration() {
  return vscode.workspace.getConfiguration(CONFIGURATION_SECTION);
}

function maxProviderRetries() {
  const configuredValue = configuration().get("maxProviderRetries", 5);
  const retries = Number(configuredValue);
  return Number.isInteger(retries) ? Math.min(Math.max(retries, 0), MAX_PROVIDER_RETRIES) : 5;
}

function loadUpstreamUrl() {
  const configuredValue = configuration().get("upstreamUrl", "");
  try {
    upstreamUrl = normalizeUpstreamUrl(configuredValue);
    lastError = null;
    if (server) {
      mode = "running";
    }
  } catch (error) {
    upstreamUrl = undefined;
    lastError = configuredValue ? error.message : null;
    if (server) {
      mode = "notConfigured";
    }
  }
}

function localEndpoint() {
  if (!upstreamUrl) {
    return `http://${LISTEN_HOST}:${LISTEN_PORT}`;
  }
  return `http://${LISTEN_HOST}:${LISTEN_PORT}${upstreamUrl.pathname}${upstreamUrl.search}`;
}

function localStatus() {
  return {
    service: SERVICE_NAME,
    mode,
    listenUrl: `http://${LISTEN_HOST}:${LISTEN_PORT}`,
    localEndpoint: localEndpoint(),
    upstream: upstreamUrl?.href ?? null,
    upstreamProtocol: "HTTP/1.1",
    startedAt,
    uptimeSeconds: startedAt ? Math.floor((Date.now() - Date.parse(startedAt)) / 1000) : 0,
    requests,
    activeRequests,
    upstreamErrors,
    providerErrors,
    providerRetries,
    maxProviderRetries: maxProviderRetries(),
    lastError,
  };
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function createProxyServer() {
  return http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__health") {
      writeJson(response, 200, localStatus());
      return;
    }

    if (!upstreamUrl) {
      writeJson(response, 503, { error: "upstream_not_configured" });
      return;
    }

    requests += 1;
    activeRequests += 1;
    updateUi();

    let finished = false;
    let activeUpstreamRequest;
    let retryTimer;
    function finishRequest() {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(retryTimer);
      activeRequests = Math.max(0, activeRequests - 1);
      updateUi();
    }

    function failRequest(error) {
      upstreamErrors += 1;
      lastError = error.message;
      finishRequest();
      if (!response.headersSent) {
        writeJson(response, 502, { error: "upstream_request_failed" });
      } else {
        response.destroy(error);
      }
    }

    function writeResponseHead(upstreamResponse) {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        forwardHeaders(upstreamResponse.headers),
      );
    }

    function forwardSseResponse(upstreamResponse, attempt) {
      const bufferedChunks = [];
      let firstEventSeen = false;
      let forwarding = false;
      let retrying = false;
      let responseEnded = false;

      function writeChunk(chunk) {
        if (!response.write(chunk)) {
          upstreamResponse.pause();
          response.once("drain", () => upstreamResponse.resume());
        }
      }

      function startForwarding() {
        if (forwarding) {
          return;
        }
        forwarding = true;
        writeResponseHead(upstreamResponse);
        for (const chunk of bufferedChunks.splice(0)) {
          writeChunk(chunk);
        }
      }

      const observer = createSseEventObserver((event) => {
        if (!firstEventSeen) {
          firstEventSeen = true;
          const retryLimit = maxProviderRetries();
          if (event.event === "error" && attempt < retryLimit && isTransientProviderError(event.data)) {
            const retryNumber = attempt + 1;
            const retryDelay = providerRetryDelayMs(retryNumber, upstreamResponse.headers);
            providerErrors += 1;
            providerRetries += 1;
            lastError = `${summarizeProviderError(event.data, upstreamResponse.headers)}; retry ${retryNumber}/${retryLimit} in ${(retryDelay / 1_000).toFixed(1)} s`;
            retrying = true;
            updateUi();
            upstreamResponse.resume();
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              sendAttempt(retryNumber);
            }, retryDelay);
            return;
          }
          if (attempt > 0 && event.event !== "error") {
            lastError = null;
            updateUi();
          }
          startForwarding();
        }
        if (event.event === "error") {
          providerErrors += 1;
          lastError = summarizeProviderError(event.data, upstreamResponse.headers);
          updateUi();
        }
      });

      upstreamResponse.on("data", (chunk) => {
        if (retrying) {
          return;
        }
        if (forwarding) {
          writeChunk(chunk);
        } else {
          bufferedChunks.push(chunk);
        }
        observer.write(chunk);
      });
      upstreamResponse.once("end", () => {
        responseEnded = true;
        observer.end();
        if (retrying) {
          return;
        }
        startForwarding();
        response.end();
        finishRequest();
      });
      upstreamResponse.once("error", (error) => {
        if (!retrying) {
          failRequest(error);
        }
      });
      upstreamResponse.once("close", () => {
        if (!retrying && !responseEnded) {
          failRequest(new Error("Upstream response closed before completion"));
        }
      });
    }

    function sendAttempt(attempt) {
      if (finished) {
        return;
      }
      activeUpstreamRequest = https.request(
        buildUpstreamRequestOptions(upstreamUrl, request),
        (upstreamResponse) => {
          const contentType = String(upstreamResponse.headers["content-type"] ?? "");
          if (contentType.toLowerCase().startsWith("text/event-stream")) {
            forwardSseResponse(upstreamResponse, attempt);
            return;
          }
          if (attempt > 0 && (upstreamResponse.statusCode ?? 500) < 400) {
            lastError = null;
            updateUi();
          }
          writeResponseHead(upstreamResponse);
          upstreamResponse.once("end", finishRequest);
          upstreamResponse.once("close", finishRequest);
          upstreamResponse.pipe(response);
        },
      );
      activeUpstreamRequest.once("error", failRequest);
      activeUpstreamRequest.end(Buffer.concat(requestChunks));
    }

    const requestChunks = [];
    request.on("data", (chunk) => requestChunks.push(chunk));
    request.once("end", () => sendAttempt(0));

    request.on("aborted", () => {
      activeUpstreamRequest?.destroy();
      finishRequest();
    });
  });
}

function readRemoteStatus() {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://${LISTEN_HOST}:${LISTEN_PORT}/__health`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(1000, () => request.destroy(new Error("Health check timed out")));
    request.on("error", reject);
  });
}

async function startProxy() {
  if (server) {
    return;
  }

  mode = "starting";
  lastError = null;
  updateUi();
  const candidate = createProxyServer();

  await new Promise((resolve) => {
    candidate.once("error", async (error) => {
      if (error.code === "EADDRINUSE") {
        try {
          const remoteStatus = await readRemoteStatus();
          if (remoteStatus.service === SERVICE_NAME) {
            mode = "shared";
            lastError = null;
          } else {
            mode = "blocked";
            lastError = `Port ${LISTEN_PORT} is used by another process`;
          }
        } catch (healthError) {
          mode = "error";
          lastError = healthError.message;
        }
      } else {
        mode = "error";
        lastError = error.message;
      }
      updateUi();
      resolve();
    });

    candidate.listen(LISTEN_PORT, LISTEN_HOST, () => {
      server = candidate;
      mode = upstreamUrl ? "running" : "notConfigured";
      startedAt = new Date().toISOString();
      updateUi();
      resolve();
    });
  });
}

async function stopProxy() {
  if (!server) {
    return;
  }
  const currentServer = server;
  server = undefined;
  await new Promise((resolve) => currentServer.close(resolve));
}

async function restartProxy() {
  await stopProxy();
  await startProxy();
}

async function getStatus() {
  if (mode !== "shared") {
    return localStatus();
  }
  try {
    return await readRemoteStatus();
  } catch (error) {
    mode = "starting";
    lastError = error.message;
    await startProxy();
    return localStatus();
  }
}

async function updateUi() {
  if (!statusBar) {
    return;
  }

  const status = await getStatus();
  if (status.mode === "running" || status.mode === "shared") {
    statusBar.text = "$(radio-tower) Fiello HTTP/1.1 Proxy";
    statusBar.backgroundColor = undefined;
  } else if (status.mode === "starting") {
    statusBar.text = "$(loading~spin) Fiello HTTP/1.1 Proxy";
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = "$(warning) Fiello HTTP/1.1 Proxy";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  statusBar.tooltip = `Fiello custom Model HTTP/1.1 Proxy: ${status.mode}`;
  statusPanel?.webview.postMessage({ type: "status", status });
}

async function saveUpstreamUrl(value) {
  const normalized = normalizeUpstreamUrl(value);
  await configuration().update("upstreamUrl", normalized.href, vscode.ConfigurationTarget.Global);
  loadUpstreamUrl();
  await updateUi();
}

async function saveMaxProviderRetries(value) {
  const retries = Number(value);
  if (!Number.isInteger(retries) || retries < 0 || retries > MAX_PROVIDER_RETRIES) {
    throw new Error(`Provider retries must be a whole number from 0 to ${MAX_PROVIDER_RETRIES}`);
  }
  await configuration().update("maxProviderRetries", retries, vscode.ConfigurationTarget.Global);
  await updateUi();
}

async function configureUpstream() {
  const value = await vscode.window.showInputBox({
    title: "Fiello custom Model HTTP/1.1 Proxy",
    prompt: "Enter the full upstream HTTPS endpoint URL",
    value: upstreamUrl?.href ?? configuration().get("upstreamUrl", ""),
    ignoreFocusOut: true,
    validateInput: (candidate) => {
      try {
        normalizeUpstreamUrl(candidate);
        return undefined;
      } catch (error) {
        return error.message;
      }
    },
  });
  if (value !== undefined) {
    await saveUpstreamUrl(value);
  }
}

function webviewHtml() {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Fiello custom Model HTTP/1.1 Proxy</title>
  <style nonce="${nonce}">
    body { padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    main { max-width: 760px; margin: 0 auto; }
    header, .actions { display: flex; align-items: center; gap: 8px; }
    header { justify-content: space-between; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 16px; }
    h1 { margin: 0; font-size: 22px; font-weight: 600; }
    button { border: 0; padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button.secondary { color: var(--vscode-secondaryButton-foreground); background: var(--vscode-secondaryButton-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover { background: var(--vscode-secondaryButton-hoverBackground); }
    .summary { display: flex; align-items: center; gap: 10px; margin: 24px 0; font-size: 16px; }
    .indicator { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-testing-iconQueued); }
    .indicator.running, .indicator.shared { background: var(--vscode-testing-iconPassed); }
    .indicator.error, .indicator.blocked, .indicator.notConfigured { background: var(--vscode-testing-iconFailed); }
    .configuration { display: grid; grid-template-columns: minmax(0, 1fr) 160px auto; align-items: end; gap: 8px; margin-bottom: 24px; }
    .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    label { color: var(--vscode-descriptionForeground); }
    input { min-width: 0; padding: 7px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    dl { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(220px, 3fr); margin: 0; border-top: 1px solid var(--vscode-panel-border); }
    dt, dd { margin: 0; padding: 10px 8px; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    dt { color: var(--vscode-descriptionForeground); }
    code, input { font-family: var(--vscode-editor-font-family); }
    .error { color: var(--vscode-errorForeground); }
    @media (max-width: 560px) { header { align-items: flex-start; flex-direction: column; } .configuration { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } dt { border-bottom: 0; padding-bottom: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Fiello custom Model HTTP/1.1 Proxy</h1>
      <div class="actions"><button id="settings" class="secondary" type="button">Settings</button><button id="restart" type="button">Restart</button></div>
    </header>
    <div class="summary"><span id="indicator" class="indicator"></span><strong id="mode">Starting</strong></div>
    <div class="configuration">
      <div class="field">
        <label for="upstream">Upstream HTTPS endpoint</label>
        <input id="upstream" type="url" spellcheck="false" placeholder="https://models.example.com/v1/responses">
      </div>
      <div class="field">
        <label for="maxProviderRetries">Maximum retries</label>
        <input id="maxProviderRetries" type="number" min="0" max="30" step="1">
      </div>
      <button id="save" type="button">Save</button>
    </div>
    <dl>
      <dt>Local endpoint</dt><dd><code id="localEndpoint">-</code></dd>
      <dt>Protocol</dt><dd id="protocol">-</dd>
      <dt>Uptime</dt><dd id="uptime">-</dd>
      <dt>Requests</dt><dd id="requests">0</dd>
      <dt>Active</dt><dd id="activeRequests">0</dd>
      <dt>Transport errors</dt><dd id="upstreamErrors">0</dd>
      <dt>Provider errors</dt><dd id="providerErrors">0</dd>
      <dt>Provider retries</dt><dd id="providerRetries">0</dd>
      <dt>Max retries per request</dt><dd id="configuredRetries">0</dd>
      <dt>Last error</dt><dd id="lastError">None</dd>
    </dl>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    let initialized = false;
    byId('restart').addEventListener('click', () => vscode.postMessage({ type: 'restart' }));
    byId('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
    byId('save').addEventListener('click', () => vscode.postMessage({
      type: 'save',
      upstream: byId('upstream').value,
      maxProviderRetries: byId('maxProviderRetries').value,
    }));
    window.addEventListener('message', ({ data }) => {
      if (data.type !== 'status') return;
      const status = data.status;
      byId('mode').textContent = status.mode;
      byId('indicator').className = 'indicator ' + status.mode;
      byId('localEndpoint').textContent = status.localEndpoint;
      byId('protocol').textContent = status.upstreamProtocol;
      byId('uptime').textContent = status.uptimeSeconds + ' s';
      byId('requests').textContent = status.requests;
      byId('activeRequests').textContent = status.activeRequests;
      byId('upstreamErrors').textContent = status.upstreamErrors;
      byId('providerErrors').textContent = status.providerErrors;
      byId('providerRetries').textContent = status.providerRetries;
      byId('configuredRetries').textContent = status.maxProviderRetries;
      byId('lastError').textContent = status.lastError || 'None';
      byId('lastError').className = status.lastError ? 'error' : '';
      if (!initialized) {
        byId('upstream').value = status.upstream || '';
        byId('maxProviderRetries').value = status.maxProviderRetries;
        initialized = true;
      }
    });
    vscode.postMessage({ type: 'refresh' });
  </script>
</body>
</html>`;
}

function showStatus(context) {
  if (statusPanel) {
    statusPanel.reveal(vscode.ViewColumn.One);
    updateUi();
    return;
  }

  statusPanel = vscode.window.createWebviewPanel(
    "customModelHttp1ProxyStatus",
    "Fiello custom Model HTTP/1.1 Proxy",
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  statusPanel.webview.html = webviewHtml();
  statusPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === "restart") {
        await restartProxy();
      } else if (message.type === "save") {
        await saveUpstreamUrl(message.upstream);
        await saveMaxProviderRetries(message.maxProviderRetries);
      } else if (message.type === "settings") {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "customModelHttp1Proxy.upstreamUrl",
        );
      }
    } catch (error) {
      lastError = error.message;
      vscode.window.showErrorMessage(error.message);
    }
    await updateUi();
  }, undefined, context.subscriptions);
  statusPanel.onDidDispose(() => {
    statusPanel = undefined;
  }, undefined, context.subscriptions);
  updateUi();
}

async function activate(context) {
  loadUpstreamUrl();
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "customModelHttp1Proxy.showStatus";
  statusBar.show();

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand("customModelHttp1Proxy.showStatus", () => showStatus(context)),
    vscode.commands.registerCommand("customModelHttp1Proxy.configure", configureUpstream),
    vscode.commands.registerCommand("customModelHttp1Proxy.restart", restartProxy),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIGURATION_SECTION}.upstreamUrl`)
        || event.affectsConfiguration(`${CONFIGURATION_SECTION}.maxProviderRetries`)
      ) {
        loadUpstreamUrl();
        updateUi();
      }
    }),
  );

  await startProxy();
  monitorTimer = setInterval(updateUi, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(monitorTimer) });

  if (!upstreamUrl && !context.globalState.get("configurationPromptShown", false)) {
    await context.globalState.update("configurationPromptShown", true);
    const action = await vscode.window.showWarningMessage(
      "Fiello custom Model HTTP/1.1 Proxy needs an upstream endpoint.",
      "Configure",
    );
    if (action === "Configure") {
      await configureUpstream();
    }
  }
}

async function deactivate() {
  clearInterval(monitorTimer);
  await stopProxy();
}

module.exports = { activate, deactivate };