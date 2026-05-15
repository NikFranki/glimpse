import * as vscode from 'vscode';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './messages';
import { buildMarkmapMarkdown } from './ui/mindmap';

export class GlimpseViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'glimpse.moduleView';

  private _view?: vscode.WebviewView;
  private _pendingMessages: ExtensionToWebviewMessage[] = [];

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
        case 'drillDown':
          vscode.commands.executeCommand(
            'glimpse.analyzeModule',
            vscode.Uri.file(msg.folderPath)
          );
          break;
      }
    });

    for (const msg of this._pendingMessages) {
      this._send(msg);
    }
    this._pendingMessages = [];
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
      display: none; align-items: center; gap: 10px; color: var(--vscode-descriptionForeground);
    }
    #state-error {
      display: none; color: var(--vscode-errorForeground);
      border-left: 3px solid var(--vscode-errorForeground);
    }
    #state-mindmap { display: none; flex: 1; overflow: hidden; }

    /* ── spinner ── */
    .spinner {
      flex-shrink: 0; width: 16px; height: 16px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent; border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── mindmap svg ── */
    #mindmap {
      width: 100%; height: 100%;
      /* invert link colors to match VSCode theme */
    }
    /* markmap node text */
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
    <div class="spinner"></div>
    <span id="loading-path" style="word-break:break-all;font-size:11px;"></span>
  </div>

  <div id="state-error"></div>

  <div id="state-mindmap">
    <svg id="mindmap"></svg>
  </div>

  <!-- markmap autoloader: bundles d3 + markmap-lib + markmap-view -->
  <script nonce="${nonce}"
    src="https://cdn.jsdelivr.net/npm/markmap-autoloader@0.17"></script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const stateWelcome = document.getElementById('state-welcome');
    const stateLoading = document.getElementById('state-loading');
    const stateError   = document.getElementById('state-error');
    const stateMindmap = document.getElementById('state-mindmap');
    const loadingPath  = document.getElementById('loading-path');
    const svgEl        = document.getElementById('mindmap');

    let mm = null; // Markmap instance

    function showOnly(el) {
      [stateWelcome, stateLoading, stateError, stateMindmap].forEach(e => {
        e.style.display = 'none';
      });
      el.style.display = el === stateLoading || el === stateWelcome ? 'flex' : 'block';
      if (el === stateMindmap) el.style.display = 'flex';
    }

    async function renderMindmap(markdown) {
      // markmap-autoloader registers window.markmap with Transformer + Markmap
      const { Transformer, Markmap } = window.markmap;
      const transformer = new Transformer();
      const { root } = transformer.transform(markdown);

      if (!mm) {
        mm = Markmap.create(svgEl, { zoom: true, pan: true });
      }
      await mm.setData(root);
      mm.fit();
    }

    // ── node click → open file ─────────────────────────────
    svgEl.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('glimpse-file:')) {
        e.preventDefault();
        const filePath = decodeURIComponent(href.slice('glimpse-file:'.length));
        vscode.postMessage({ type: 'openFile', filePath });
      }
    });

    // ── messages from extension ────────────────────────────
    window.addEventListener('message', async (event) => {
      const msg = event.data;

      if (msg.type === 'loading') {
        showOnly(stateLoading);
        loadingPath.textContent = msg.modulePath;
        return;
      }

      if (msg.type === 'error') {
        showOnly(stateError);
        stateError.textContent = '⚠ ' + msg.message;
        return;
      }

      if (msg.type === 'data') {
        showOnly(stateMindmap);
        try {
          await renderMindmap(msg.markdown);
        } catch (err) {
          showOnly(stateError);
          stateError.textContent = '渲染失败: ' + (err && err.message || String(err));
        }
      }
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
