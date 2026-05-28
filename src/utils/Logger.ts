import * as vscode from 'vscode';

let _outputChannel: vscode.OutputChannel | undefined;
let _trafficChannel: vscode.OutputChannel | undefined;
let _serialChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('ACP Client');
  }
  return _outputChannel;
}

export function getTrafficChannel(): vscode.OutputChannel {
  if (!_trafficChannel) {
    _trafficChannel = vscode.window.createOutputChannel('ACP Traffic');
  }
  return _trafficChannel;
}

export function getSerialChannel(): vscode.OutputChannel {
  if (!_serialChannel) {
    _serialChannel = vscode.window.createOutputChannel('Embedder Monitor');
  }
  return _serialChannel;
}

function isVerboseSerial(): boolean {
  return vscode.workspace.getConfiguration('embedderMonitor').get<boolean>('verboseLog', false);
}

export function logSerial(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => safeStringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getSerialChannel().appendLine(formatted);
}

export function logSerialDebug(message: string, ...args: unknown[]): void {
  if (!isVerboseSerial()) {
    return;
  }
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] DEBUG ${message} ${args.map(a => safeStringify(a)).join(' ')}`
    : `[${timestamp}] DEBUG ${message}`;
  getSerialChannel().appendLine(formatted);
}

export function logSerialError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getSerialChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getSerialChannel().appendLine(error.stack);
  }
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') {
      return v;
    }
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(message: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const formatted = args.length > 0
    ? `[${timestamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${timestamp}] ${message}`;
  getOutputChannel().appendLine(formatted);
}

export function logError(message: string, error?: unknown): void {
  const timestamp = new Date().toISOString();
  const errMsg = error instanceof Error ? error.message : String(error ?? '');
  getOutputChannel().appendLine(`[${timestamp}] ERROR: ${message} ${errMsg}`);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
  }
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  const config = vscode.workspace.getConfiguration('acp');
  if (!config.get<boolean>('logTraffic', true)) {
    return;
  }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const timestamp = new Date().toISOString();

  // Classify message type
  const msg = data as Record<string, unknown> | null;
  let label = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
    } else if ('method' in msg && !('id' in msg)) {
      label = ` [NOTIFICATION] ${msg.method}`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
    }
  }

  getTrafficChannel().appendLine(
    `[${timestamp}] ${arrow}${label}\n${JSON.stringify(data, null, 2)}\n`
  );
}

export function disposeChannels(): void {
  _outputChannel?.dispose();
  _trafficChannel?.dispose();
  _serialChannel?.dispose();
  _outputChannel = undefined;
  _trafficChannel = undefined;
  _serialChannel = undefined;
}
