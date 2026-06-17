# Interceptor

Interceptor is a Chrome/Chromium DevTools extension that records request history and lets you send any captured request to an editable repeater.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.
5. Open DevTools on a target tab and choose the **Interceptor** panel.

## Use

- Keep the Interceptor DevTools panel open while browsing the authorized test target.
- Select an item in the request history to inspect raw request and response text.
- Click **Send to Repeater** to create a new repeater tab for that request.
- Switch between repeater tabs, edit each raw request independently, then click **Send**.
- Click **Download Project** to save the current history, repeater requests, and repeater responses as JSON.
- Click **Upload Project** to restore a previously downloaded project JSON file.

## Notes

- Chrome extensions cannot read arbitrary response bodies through the normal `webRequest` API. This extension uses the DevTools Network API, so capture works while DevTools is open.
- Some browser-controlled headers such as `Cookie`, `Host`, `Content-Length`, `Origin`, `Referer`, and `sec-*` cannot be set directly by extension `fetch`.
- Use this only on systems you own or have explicit permission to test.
