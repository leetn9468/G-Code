---
name: browser-verify
description: Generate and verify local browser plans with real evidence
trigger: BrowserVerify|BrowserPlan|/browser-verify|浏览器.*验证
---

# Browser verification

Read the project's HTML/JS first. Derive meaningful scenarios from the user's requirements and the actual controls. Use BrowserPlan to save a new version-2 plan; do not merely check page load. Include important initial states, real interactions and their expected outcomes, plus responsive layout where relevant. A fixed seed makes Math.random reproducible; it does not freeze time, network or crypto randomness.

Example BrowserPlan input:
```json
{"plan_file":".gcode/browser-tests/form.json","plan":{"version":2,"entry":"index.html","seed":1,"steps":[{"name":"Enter name","action":"fill","selector":"#name","value":"Lin"},{"name":"Save","action":"click","selector":"#save"},{"name":"Saved result","action":"expect","expected":{"kind":"text","selector":"#result","equals":"Lin"}},{"name":"Evidence","action":"screenshot"}]}}
```
BrowserPlan validates and saves create-only. It does not execute the page. Call BrowserPlanCheck separately on the saved file, inspect its assessment and coverage, then pass the exact planSha256 as plan_sha256 to BrowserVerify. Changed bytes require another check. Structural validation is independent of the generator; it cannot establish that the chosen tests cover every requirement. The browser independently reads real UI state and evaluates each expected value.

Every step needs a unique name. Version 2 actions: click(selector), fill(selector,value), check(selector,checked), select(selector,value), press(key), expect(expected,timeout_ms), wait(ms), screenshot, viewport(width,height), background(ms). Expectations are strict objects with kind text/value/visible/checked/count (selector and equals), title/path (equals), or no-horizontal-overflow. No arbitrary page expression is accepted in version 2. Use exact state assertions, not always-true checks. Maximum 60 steps, 15 seconds per assertion, 5 seconds per wait and 180 seconds for the whole tool run.

For a development server, include server:{command,args,path,ready_timeout_ms}. Args must contain {port}; G-Code replaces it with an allocated loopback port. Example: command:"npm", args:["run","dev","--","--host","127.0.0.1","--port","{port}","--strictPort"], path:"/". The exact command is shown for approval. Dependencies must already be installed. No shell expansion is used; the command runs in the project and has ordinary local process authority. Read its script before proposing it. G-Code owns and stops this server; the plan must not name an unrelated long-running service. Same-origin HTTP and same-host WebSockets support local development assets. Foreign origins, service workers, downloads and personal browser profiles are blocked. The entry hash identifies source provenance, not transformed server response bytes.

For exploration, Settings > Tools & MCP > Add built-in browser installs a local adapter preset for new chats. Its browser_open accepts a project HTML entry or an explicit http loopback URL with port. snapshot/click/fill/press/expect/screenshot/close support real interactions and saved trace evidence. Close the browser when done. An interaction record is not a full verification pass. These MCP calls use the normal permission checks.

Legacy reviewed version-1 plans remain supported. They can contain page assert/capture expressions, so the assessment explicitly cannot certify mutation-free assertions. Do not generate new version-1 plans. background uses a real second tab and observes actual visibility; it never synthesizes visibility events. Headed mode may be necessary on some systems.

A failed expectation stops the plan and marks later steps skipped. Page/console errors fail the run. Cancellation, timeout, setup errors and missing reports cannot pass. Retain the original failed evidence when fixing a plan or source. Outputs records reports, screenshots and trace.zip, with immutable content snapshots up to 64 MiB per file. Use Open trace viewer from a tracked trace output; Close viewer stops only G-Code's owned viewer. Report the observed checks and any unverified behavior, not an unsupported claim of complete application coverage.
