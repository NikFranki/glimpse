import * as vscode from 'vscode';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './messages';
import { buildMarkmapMarkdown } from './ui/mindmap';

export class GlimpseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'glimpse.moduleView';

  private _view?: vscode.WebviewView;
  private _pendingMessages: ExtensionToWebviewMessage[] = [];
  private _lastDataMessage: ExtensionToWebviewMessage | null = null;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      switch (msg.type) {
        case 'openFile':
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.filePath));
          break;
        case 'openFolder':
          vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.folderPath));
          break;
        case 'openUrl':
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        case 'drillDown':
          vscode.commands.executeCommand(
            'glimpse.analyzeModule',
            vscode.Uri.file(msg.folderPath)
          );
          break;
      }
    });

    if (this._pendingMessages.length > 0) {
      for (const msg of this._pendingMessages) {
        this._send(msg);
      }
      this._pendingMessages = [];
    } else if (this._lastDataMessage) {
      // Restore last result when panel is re-opened after being collapsed.
      this._send(this._lastDataMessage);
    }
  }

  postMessage(message: ExtensionToWebviewMessage): void {
    if (this._view) {
      this._send(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  focusView(): Thenable<unknown> {
    return vscode.commands.executeCommand(`${GlimpseViewProvider.viewId}.focus`);
  }

  /** Enrich data messages with pre-built markdown before forwarding to the webview. */
  private _send(message: ExtensionToWebviewMessage): void {
    if (message.type === 'data') {
      this._lastDataMessage = message;
      const markdown = buildMarkmapMarkdown(message.analysis);
      this._view?.webview.postMessage({ ...message, markdown });
    } else {
      this._view?.webview.postMessage(message);
    }
  }

  private _getHtml(): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
             style-src 'unsafe-inline' https://cdn.jsdelivr.net;
             img-src data: https:;
             font-src data: https://cdn.jsdelivr.net;" />
  <title>Glimpse</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      height: 100vh;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }

    /* ── states ── */
    #state-welcome, #state-loading, #state-error { padding: 24px 16px; }
    #state-welcome {
      display: flex; flex-direction: column;
      align-items: center; gap: 10px;
      margin-top: 40px; opacity: 0.6; text-align: center;
    }
    #state-loading {
      display: none; flex-direction: column;
      padding: 20px 16px; gap: 0;
    }
    #loading-header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 14px; color: var(--vscode-descriptionForeground); font-size: 11px;
    }
    #loading-steps { display: flex; flex-direction: column; gap: 0; }
    .step-row {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 0; font-size: 12px;
      color: var(--vscode-descriptionForeground);
      border-left: 2px solid transparent;
    }
    .step-row.step-done {
      color: var(--vscode-foreground);
      border-left-color: var(--vscode-terminal-ansiGreen, #4ec9b0);
    }
    .step-row.step-active {
      color: var(--vscode-foreground);
      border-left-color: var(--vscode-focusBorder, #007acc);
    }
    .step-icon { width: 14px; text-align: center; flex-shrink: 0; font-size: 11px; }
    .step-text { flex: 1; line-height: 1.4; }
    .step-timer { color: var(--vscode-focusBorder, #007acc); font-size: 11px; font-variant-numeric: tabular-nums; flex-shrink: 0; margin-left: auto; padding-left: 8px; }
    #state-error {
      display: none; flex-direction: column; gap: 10px;
      padding: 16px; color: var(--vscode-errorForeground);
      border-left: 3px solid var(--vscode-errorForeground);
    }
    #error-message { word-break: break-word; font-size: 12px; }
    #retry-btn {
      align-self: flex-start; padding: 4px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 2px; cursor: pointer; font-size: 12px;
    }
    #retry-btn:hover { background: var(--vscode-button-hoverBackground); }
    #state-mindmap { display: none; flex: 1; overflow: hidden; position: relative; }

    /* ── toolbar ── */
    #toolbar {
      position: absolute; top: 6px; right: 6px; z-index: 10;
      display: flex; flex-direction: column; gap: 3px;
    }
    .tb-btn {
      width: 28px; height: 28px; padding: 0;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 3px; cursor: pointer;
      font-size: 12px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.75; line-height: 1;
    }
    .tb-btn:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .tb-sep { height: 1px; background: var(--vscode-widget-border, #555); margin: 2px 0; }

    /* ── spinner ── */
    .spinner {
      flex-shrink: 0; width: 12px; height: 12px;
      border: 2px solid var(--vscode-focusBorder, #007acc);
      border-top-color: transparent; border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── mindmap svg ── */
    #mindmap {
      width: 100%; height: 100%;
    }
    /* markmap node text — force visible against dark backgrounds */
    .markmap-foreign { color: var(--vscode-foreground, #cccccc); }
    .markmap-foreign a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .markmap-foreign a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div id="state-welcome">
    <div>💡</div>
    <p>右键文件夹 →<br><strong>Glimpse: 分析此模块</strong></p>
  </div>

  <div id="state-loading">
    <div id="loading-header">
      <div class="spinner"></div>
      <span id="loading-path" style="word-break:break-all;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
    </div>
    <div id="loading-steps"></div>
  </div>

  <div id="state-error">
    <span id="error-message"></span>
    <button id="retry-btn">重试</button>
  </div>

  <div id="state-mindmap">
    <div id="toolbar">
      <button class="tb-btn" id="btn-fit"      title="适应屏幕">⊡</button>
      <button class="tb-btn" id="btn-zoom-in"  title="放大">＋</button>
      <button class="tb-btn" id="btn-zoom-out" title="缩小">－</button>
      <div class="tb-sep"></div>
      <button class="tb-btn" id="btn-export-svg" title="导出 SVG" style="font-size:9px;">SVG</button>
      <button class="tb-btn" id="btn-export-png" title="导出 PNG" style="font-size:9px;">PNG</button>
    </div>
    <svg id="mindmap"></svg>
  </div>

  <!-- markmap autoloader: bundles d3 + markmap-lib + markmap-view -->
  <script nonce="${nonce}"
    src="https://cdn.jsdelivr.net/npm/markmap-autoloader@0.17"></script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const stateWelcome  = document.getElementById('state-welcome');
    const stateLoading  = document.getElementById('state-loading');
    const stateError    = document.getElementById('state-error');
    const stateMindmap  = document.getElementById('state-mindmap');
    const loadingPath   = document.getElementById('loading-path');
    const loadingSteps  = document.getElementById('loading-steps');
    const errorMessage  = document.getElementById('error-message');
    const retryBtn      = document.getElementById('retry-btn');
    const svgEl         = document.getElementById('mindmap');

    let mm = null;               // Markmap instance
    let currentModulePath = '';  // last analyzed folder, used by retry
    let activeStepEl = null;     // current in-progress step row
    let stepTimerInterval = null;
    let stepStartTime = 0;

    // ── flex containers need display:flex, others display:block ──
    const FLEX_STATES = new Set([stateWelcome, stateLoading, stateError, stateMindmap]);
    function showOnly(el) {
      FLEX_STATES.forEach(e => { e.style.display = 'none'; });
      el.style.display = 'flex';
    }

    // ── retry button ───────────────────────────────────────────
    retryBtn.addEventListener('click', () => {
      if (currentModulePath) {
        vscode.postMessage({ type: 'drillDown', folderPath: currentModulePath });
      }
    });

    // ── toolbar ────────────────────────────────────────────────
    document.getElementById('btn-fit').addEventListener('click', () => mm?.fit());

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      if (!mm) return;
      mm.zoom.scaleBy(mm.svg, 1.3);
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      if (!mm) return;
      mm.zoom.scaleBy(mm.svg, 1 / 1.3);
    });

    document.getElementById('btn-export-svg').addEventListener('click', () => {
      if (!svgEl) return;
      const name = currentModulePath.split('/').filter(Boolean).pop() || 'mindmap';
      // Clone SVG and embed minimal style so the exported file is self-contained
      const clone = svgEl.cloneNode(true);
      const bbox = svgEl.getBBox ? svgEl.getBBox() : { width: svgEl.clientWidth, height: svgEl.clientHeight, x: 0, y: 0 };
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', bbox.width || svgEl.clientWidth);
      clone.setAttribute('height', bbox.height || svgEl.clientHeight);
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent = 'text { fill: #ccc; font-family: sans-serif; font-size: 14px; } line, path { stroke: #555; }';
      clone.insertBefore(style, clone.firstChild);
      const svgStr = new XMLSerializer().serializeToString(clone);
      const b64 = btoa(unescape(encodeURIComponent(svgStr)));
      const a = document.createElement('a');
      a.href = 'data:image/svg+xml;base64,' + b64;
      a.download = name + '-mindmap.svg';
      a.click();
    });

    document.getElementById('btn-export-png').addEventListener('click', () => {
      if (!svgEl) return;
      const name = currentModulePath.split('/').filter(Boolean).pop() || 'mindmap';
      const w = svgEl.clientWidth || 1200;
      const h = svgEl.clientHeight || 800;
      const svgStr = new XMLSerializer().serializeToString(svgEl);
      const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = 2; // retina
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
        ctx.fillRect(0, 0, w, h);
        try {
          ctx.drawImage(img, 0, 0, w, h);
        } catch (_) { /* cross-origin taint — skip background draw */ }
        const a = document.createElement('a');
        a.href = canvas.toDataURL('image/png');
        a.download = name + '-mindmap.png';
        a.click();
      };
      img.src = dataUrl;
    });

    function waitForMarkmap(maxMs = 8000) {
      return new Promise((resolve) => {
        const start = Date.now();
        (function poll() {
          if (window.markmap?.Transformer && window.markmap?.Markmap) return resolve(true);
          if (Date.now() - start > maxMs) return resolve(false);
          setTimeout(poll, 60);
        })();
      });
    }

    async function renderMindmap(markdown) {
      // markmap-autoloader registers window.markmap with Transformer + Markmap
      await waitForMarkmap();
      const { Transformer, Markmap } = window.markmap;
      const transformer = new Transformer();
      const { root } = transformer.transform(markdown);

      // Fold file-level nodes (depth >= 3) by default so Props/State/方法 are
      // collapsed until the user clicks to expand. Depth 0 = root, 1 = sections
      // (模块职责…), 2 = feature/group, 3 = file nodes inside data flow.
      foldAtDepth(root, 0);

      if (!mm) {
        mm = Markmap.create(svgEl, { zoom: true, pan: true });
      }
      await mm.setData(root);
      mm.fit();
    }

    function foldAtDepth(node, depth) {
      if (depth >= 3 && node.children && node.children.length > 0) {
        node.payload = Object.assign({}, node.payload, { fold: 1 });
      }
      for (const child of (node.children || [])) {
        foldAtDepth(child, depth + 1);
      }
    }

    // ── node click → open file ─────────────────────────────
    // Use capture phase so we intercept before the webview's default link
    // navigation swallows the unknown "glimpse-file:" scheme silently.
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('glimpse-file:')) {
        e.preventDefault();
        e.stopPropagation();
        const filePath = decodeURIComponent(href.slice('glimpse-file:'.length));
        vscode.postMessage({ type: 'openFile', filePath });
      } else if (href.startsWith('glimpse-pkg:')) {
        e.preventDefault();
        e.stopPropagation();
        const pkg = decodeURIComponent(href.slice('glimpse-pkg:'.length));
        vscode.postMessage({ type: 'openUrl', url: 'https://www.npmjs.com/package/' + pkg });
      } else if (href.startsWith('glimpse-mod:')) {
        e.preventDefault();
        e.stopPropagation();
        const folderPath = decodeURIComponent(href.slice('glimpse-mod:'.length));
        vscode.postMessage({ type: 'openFolder', folderPath });
      }
    }, true);

    // ── step list helpers ──────────────────────────────────
    function clearStepTimer() {
      if (stepTimerInterval) { clearInterval(stepTimerInterval); stepTimerInterval = null; }
    }

    function addStep(text) {
      clearStepTimer();
      // Mark previous active step as done (keep its elapsed time)
      if (activeStepEl) {
        activeStepEl.classList.remove('step-active');
        activeStepEl.classList.add('step-done');
        activeStepEl.querySelector('.step-icon').textContent = '✓';
      }
      const row = document.createElement('div');
      row.className = 'step-row step-active';
      row.innerHTML = '<span class="step-icon"><span class="spinner" style="display:inline-block;"></span></span>'
                    + '<span class="step-text"></span>'
                    + '<span class="step-timer">0s</span>';
      row.querySelector('.step-text').textContent = text;
      loadingSteps.appendChild(row);
      activeStepEl = row;
      stepStartTime = Date.now();
      const timerEl = row.querySelector('.step-timer');
      stepTimerInterval = setInterval(() => {
        const ms = Date.now() - stepStartTime;
        timerEl.textContent = ms < 10000
          ? (ms / 1000).toFixed(1) + 's'
          : Math.floor(ms / 1000) + 's';
      }, 100);
    }

    function finalizeSteps() {
      clearStepTimer();
      if (activeStepEl) {
        activeStepEl.classList.remove('step-active');
        activeStepEl.classList.add('step-done');
        activeStepEl.querySelector('.step-icon').textContent = '✓';
        activeStepEl = null;
      }
    }

    // ── messages from extension ────────────────────────────
    window.addEventListener('message', async (event) => {
      const msg = event.data;

      if (msg.type === 'loading') {
        currentModulePath = msg.modulePath;
        clearStepTimer();
        loadingSteps.innerHTML = '';
        activeStepEl = null;
        const short = msg.modulePath.split('/').filter(Boolean).slice(-2).join('/');
        loadingPath.textContent = short || msg.modulePath;
        showOnly(stateLoading);
        return;
      }

      if (msg.type === 'progress') {
        addStep(msg.step);
        return;
      }

      if (msg.type === 'error') {
        if (msg.modulePath) currentModulePath = msg.modulePath;
        finalizeSteps();
        showOnly(stateError);
        errorMessage.textContent = '⚠ ' + msg.message;
        return;
      }

      if (msg.type === 'data') {
        finalizeSteps();
        showOnly(stateMindmap);
        try {
          await renderMindmap(msg.markdown);
          vscode.setState({ markdown: msg.markdown, modulePath: currentModulePath });
        } catch (err) {
          showOnly(stateError);
          stateError.textContent = '渲染失败: ' + (err && err.message || String(err));
        }
      }
    });

    // ── restore state after panel close/reopen ─────────────
    const saved = vscode.getState();
    if (saved && saved.markdown) {
      currentModulePath = saved.modulePath || '';
      showOnly(stateMindmap);
      renderMindmap(saved.markdown).catch((err) => {
        showOnly(stateError);
        errorMessage.textContent = '⚠ 恢复失败: ' + (err && err.message || String(err));
      });
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
