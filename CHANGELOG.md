# Changelog

## 0.2.1

- Added up to 30 configurable retries for transient provider SSE errors that
  arrive before the first response event, with progressive delays and
  `Retry-After` support.
- Clear the dashboard's last error after a retry successfully starts a response.
- Added sanitized provider error details and separate provider retry counters.
- Updated the extension UI with Fiello branding.

## 0.2.0

- Added a configurable upstream HTTPS endpoint.
- Added configuration through VS Code Settings, the Command Palette, and the
  status webview.
- Added runtime status, counters, error reporting, and restart controls.
- Added multi-window listener sharing.
- Removed environment-specific endpoint and lifecycle assumptions.

## 0.1.0

- Initial local HTTP/1.1 proxy prototype.
