// Builds tools/screenshot/demo.html: the real media/map.html, fed demo-data.js, with VS Code's Dark Modern colours.
//   node tools/screenshot/build-demo.js   then   node tools/screenshot/shoot.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const data = require('./demo-data.js');
let h = fs.readFileSync(path.join(root, 'media', 'map.html'), 'utf8');
h = h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/s, '');          // a local file, no webview CSP
h = h.replace(/\{\{nonce\}\}/g, 'demo').replace(/\{\{critters\}\}/g, '../../media/critters.js').replace(/\{\{tray\}\}/g, 'up');
const theme = `<style>:root {
  --vscode-foreground:#cccccc; --vscode-descriptionForeground:#9d9d9d; --vscode-editor-background:#1f1f1f;
  --vscode-editorHoverWidget-background:#202020; --vscode-editorHoverWidget-border:#454545; --vscode-focusBorder:#0078d4;
  --vscode-input-background:#313131; --vscode-input-foreground:#cccccc; --vscode-input-border:#3c3c3c;
  --vscode-button-background:#0078d4; --vscode-button-foreground:#ffffff; --vscode-button-secondaryBackground:#313131;
  --vscode-button-secondaryForeground:#cccccc; --vscode-sideBar-background:#181818; --vscode-list-hoverBackground:#2a2d2e;
  --vscode-list-inactiveSelectionBackground:#37373d; --vscode-menu-background:#1f1f1f; --vscode-menu-foreground:#cccccc;
  --vscode-menu-selectionBackground:#0078d4; --vscode-textLink-foreground:#4daafc; --vscode-dropdown-background:#313131;
  --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#3c3c3c; --vscode-errorForeground:#f85149;
  --vscode-font-family: "Segoe UI", "Inter", "DejaVu Sans", system-ui, sans-serif; --vscode-font-size: 13px; }</style>`;
const stub = `<script>
  const DEMO = ${JSON.stringify(data)};
  window.acquireVsCodeApi = () => ({
    postMessage(m) { if (m.type === 'ready' || m.type === 'refresh') setTimeout(() => window.postMessage({ type: 'data', data: DEMO }, '*'), 30); },
    getState() { return { layout: 'grouped', bg: (new URLSearchParams(location.search).get('bg') || 'city'), bgv: 2, style: 'bot', selected: ['a1f3c9d2-1'] }; },
    setState() {},
  });
</script>`;
h = h.replace('</head>', theme + stub + '</head>');
fs.writeFileSync(path.join(__dirname, 'demo.html'), h);
console.log('tools/screenshot/demo.html');
