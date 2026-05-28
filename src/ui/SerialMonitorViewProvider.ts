import * as vscode from 'vscode';
import { SerialManager, SerialPortInfo, SerialStatus } from '../core/SerialManager';
import { logSerial, logSerialDebug, logSerialError } from '../utils/Logger';

export class SerialMonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'embedderMonitor.serialLog';

  private view?: vscode.WebviewView;
  private dataListener?: vscode.Disposable;
  private statusListener?: vscode.Disposable;

  // Periodic port-list refresh so the dropdown follows USB plug/unplug events.
  private pollHandle?: NodeJS.Timeout;
  private readonly pollIntervalMs = 3000;
  private lastPortsKey = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly serialManager: SerialManager,
  ) {
    // Forward serial data to the webview when visible.
    this.dataListener = this.serialManager.onData(e => {
      if (this.view) {
        try {
          this.view.webview.postMessage({ type: 'onData', data: e.data });
        } catch (err) {
          logSerialError('postMessage onData failed', err);
        }
      } else {
        logSerialDebug(`onData (${e.data.length} chars) — view not resolved yet`);
      }
    });

    // Forward connection status transitions to the UI so it can never get stuck.
    this.statusListener = this.serialManager.onStatus(status => {
      this.broadcastStatus(status);
    });
  }

  private broadcastStatus(status: SerialStatus): void {
    if (!this.view) {
      logSerialDebug(`status buffered — view not resolved yet (${status.kind})`);
      return;
    }
    switch (status.kind) {
      case 'connecting':
        this.view.webview.postMessage({
          type: 'connecting',
          path: status.path,
          baud: status.baud,
          mode: status.mode,
        });
        break;
      case 'connected':
        this.view.webview.postMessage({
          type: 'connected',
          path: status.path,
          baud: status.baud,
          mode: status.mode,
        });
        break;
      case 'disconnected':
        this.view.webview.postMessage({
          type: 'disconnected',
          path: status.path,
          reason: status.reason,
        });
        break;
      case 'error':
        this.view.webview.postMessage({
          type: 'error',
          path: status.path,
          message: status.message,
        });
        break;
      case 'idle':
      default:
        break;
    }
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.onDidDispose(() => {
      logSerialDebug('webview disposed');
      this.view = undefined;
      this.stopPolling();
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.startPolling();
      } else {
        this.stopPolling();
      }
    });

    webviewView.webview.onDidReceiveMessage(async data => {
      try {
        await this.handleMessage(webviewView, data);
      } catch (err) {
        logSerialError(`handleMessage(${data?.type}) threw`, err);
      }
    });

    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollHandle) {
      return;
    }
    logSerialDebug(`port-list polling started (interval=${this.pollIntervalMs}ms)`);
    this.pollHandle = setInterval(() => {
      this.pollPortsTick().catch(err => logSerialError('poll tick failed', err));
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
      logSerialDebug('port-list polling stopped');
    }
  }

  private async pollPortsTick(): Promise<void> {
    if (!this.view) {
      return;
    }
    // Skip while a real port is open — listPorts on some platforms briefly
    // contends with the active handle and an open port path is already known.
    if (this.serialManager.isOpen() && this.serialManager.getMode() === 'real') {
      return;
    }
    const ports = await this.serialManager.listPorts();
    const key = ports.map(p => `${p.path}|${p.label}|${p.virtual ? 'V' : 'R'}`).join(';');
    if (key === this.lastPortsKey) {
      return; // No change — avoid pointless DOM churn / dropdown reset.
    }
    this.lastPortsKey = key;
    const config = vscode.workspace.getConfiguration('embedderMonitor');
    const defaultPort = config.get<string>('defaultPort') || '';
    this.view.webview.postMessage({
      type: 'ports',
      ports,
      defaultPort,
      mode: this.serialManager.getMode(),
      nativeAvailable: this.serialManager.isNativeAvailable(),
    });
    logSerialDebug(`port-list updated (${ports.length} entries)`);
  }

  private async handleMessage(view: vscode.WebviewView, data: { type: string; [k: string]: unknown }): Promise<void> {
    logSerialDebug(`webview → ext: ${data.type}`);
    switch (data.type) {
      case 'ready': {
        // Replay buffered output FIRST so the operator sees prior context,
        // then advertise the static load info / current status.
        const recentData = this.serialManager.getRecentData();
        if (recentData.length > 0) {
          view.webview.postMessage({
            type: 'restoreHistory',
            data: recentData.join(''),
          });
        }
        view.webview.postMessage({
          type: 'modeInfo',
          mode: this.serialManager.getMode(),
          nativeAvailable: this.serialManager.isNativeAvailable(),
          loadError: this.serialManager.getLoadError()?.message,
        });
        // Replay current connection status.
        if (this.serialManager.isOpen()) {
          view.webview.postMessage({
            type: 'connected',
            path: this.serialManager.getCurrentPath(),
            baud: this.serialManager.getCurrentBaud(),
            mode: this.serialManager.getMode(),
          });
        } else {
          view.webview.postMessage({ type: 'disconnected', path: '' });
        }
        // Auto-list ports right away so the dropdown is populated.
        await this.sendPortList(view);
        break;
      }
      case 'connect': {
        const port = String(data.port ?? '');
        const baud = Number(data.baud ?? 0);
        try {
          await this.serialManager.connect(port, baud);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          view.webview.postMessage({ type: 'error', path: port, message: msg });
          view.webview.postMessage({ type: 'disconnected', path: port, reason: msg });
        }
        break;
      }
      case 'disconnect': {
        await this.serialManager.disconnect();
        break;
      }
      case 'send': {
        const message = String(data.message ?? '');
        const newline = String(data.newline ?? '');
        try {
          await this.serialManager.send(message, newline);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          view.webview.postMessage({ type: 'error', message: msg });
        }
        break;
      }
      case 'listPorts': {
        await this.sendPortList(view);
        break;
      }
      default:
        logSerialDebug(`unknown message type: ${data.type}`);
    }
  }

  private async sendPortList(view: vscode.WebviewView): Promise<void> {
    const ports: SerialPortInfo[] = await this.serialManager.listPorts();
    const config = vscode.workspace.getConfiguration('embedderMonitor');
    const defaultPort = config.get<string>('defaultPort') || '';
    this.lastPortsKey = ports.map(p => `${p.path}|${p.label}|${p.virtual ? 'V' : 'R'}`).join(';');
    view.webview.postMessage({
      type: 'ports',
      ports,
      defaultPort,
      mode: this.serialManager.getMode(),
      nativeAvailable: this.serialManager.isNativeAvailable(),
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'serialMonitor', 'serialMonitor.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'serialMonitor', 'serialMonitor.css'),
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Embedder Monitor</title>
    <link href="${styleUri}" rel="stylesheet">
</head>
<body>
    <div class="header">
        <h2 class="title">EMBEDDER MONITOR:</h2>
        <span id="mode-badge" class="badge badge-unknown" title="Native serial mode">…</span>
    </div>

    <div class="port-tabs">
        <div class="active-tab">
            <span class="tab-icon">&gt;</span>
            <span id="current-port-display">Not connected</span>
        </div>
        <button id="add-port-btn" title="Add Port" disabled>+</button>
    </div>

    <div class="controls">
        <button id="connect-btn" class="btn primary">Connect</button>
        <button id="filter-btn" class="btn" disabled>Filter</button>
        <button id="clear-btn" class="btn">Clear</button>
        <button id="detect-baud-btn" class="btn" disabled>Detect baud</button>
        <button id="refresh-ports-btn" class="btn" title="Refresh port list">↻ Ports</button>
    </div>

    <div class="output-container">
        <textarea id="serial-output" readonly spellcheck="false" placeholder="No serial output yet."></textarea>
    </div>

    <div class="bottom-toolbar">
        <div class="command-row">
            <input type="text" id="command-input" placeholder="Connect to send commands" disabled>
            <button id="send-btn" class="icon-btn" disabled>↑</button>
        </div>

        <div class="config-row">
            <div class="config-item port-config">
                <label for="port-select">Port</label>
                <select id="port-select"></select>
            </div>

            <div class="config-item baud-config">
                <label for="baud-select">Baud</label>
                <select id="baud-select">
                    <option value="9600">9600</option>
                    <option value="19200">19200</option>
                    <option value="38400">38400</option>
                    <option value="57600">57600</option>
                    <option value="74880">74880</option>
                    <option value="115200" selected>115200</option>
                    <option value="230400">230400</option>
                    <option value="460800">460800</option>
                    <option value="921600">921600</option>
                </select>
            </div>

            <div class="config-item nl-config">
                <label for="nl-select">NL</label>
                <select id="nl-select">
                    <option value="">None</option>
                    <option value="\n" selected>LF (\\n)</option>
                    <option value="\r">CR (\\r)</option>
                    <option value="\r\n">CRLF (\\r\\n)</option>
                </select>
            </div>
        </div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    this.stopPolling();
    this.dataListener?.dispose();
    this.statusListener?.dispose();
    logSerial('SerialMonitorViewProvider disposed');
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
