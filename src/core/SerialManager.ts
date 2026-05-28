import * as vscode from 'vscode';
import { logSerial, logSerialDebug, logSerialError } from '../utils/Logger';

export interface SerialDataEvent {
  data: string;
}

export type SerialMode = 'real' | 'virtual';

export interface SerialPortInfo {
  /** Underlying device path / system name (e.g. COM3, /dev/ttyUSB0). */
  path: string;
  /** Human-readable label combining manufacturer + path (used in UI). */
  label: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  /** True when this entry comes from the virtual simulator pool. */
  virtual?: boolean;
}

export type SerialStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; path: string; baud: number; mode: SerialMode }
  | { kind: 'connected'; path: string; baud: number; mode: SerialMode }
  | { kind: 'disconnected'; path: string; reason?: string }
  | { kind: 'error'; path: string; message: string };

interface SerialPortLoadResult {
  ok: boolean;
  // serialport@13 default export shape: { SerialPort, ... }
  // We only need the SerialPort constructor. Stored as `any` to avoid
  // leaking serialport types into our public API.
  SerialPort?: any;
  loadError?: Error;
}

/**
 * Manages a single active serial connection — physical (via the optional
 * native `serialport` module) with transparent fallback to an in-process
 * virtual simulator. Designed as a process-wide singleton so multiple ACP
 * agent sessions share one physical port (resource lock).
 */
export class SerialManager {
  private currentPort: any = null;
  private onDataEmitter = new vscode.EventEmitter<SerialDataEvent>();
  public readonly onData = this.onDataEmitter.event;

  private onStatusEmitter = new vscode.EventEmitter<SerialStatus>();
  public readonly onStatus = this.onStatusEmitter.event;

  private isConnected = false;
  private currentPath = '';
  private currentBaud = 0;
  private currentMode: SerialMode = 'real';
  private loadResult: SerialPortLoadResult | undefined;

  constructor() {
    logSerial('SerialManager initialized');
    // Eagerly probe so listPorts/connect share the same outcome.
    void this.getLoadResult();
  }

  // -------------------- Public API --------------------

  public get isVirtual(): boolean {
    return this.currentMode === 'virtual';
  }

  public getMode(): SerialMode {
    return this.currentMode;
  }

  public getCurrentPath(): string {
    return this.currentPath;
  }

  public getCurrentBaud(): number {
    return this.currentBaud;
  }

  public isOpen(): boolean {
    return this.isConnected;
  }

  /** Returns true when the native `serialport` module loaded successfully. */
  public isNativeAvailable(): boolean {
    return !!this.loadResult?.ok;
  }

  public getLoadError(): Error | undefined {
    return this.loadResult?.loadError;
  }

  /**
   * Enumerate available ports. When the native module is loaded, returns
   * real OS ports with manufacturer info. When it failed to load, returns
   * virtual placeholder ports (so the UI is still usable).
   */
  public async listPorts(): Promise<SerialPortInfo[]> {
    const result = await this.getLoadResult();
    if (result.ok && result.SerialPort) {
      try {
        const raw: Array<Record<string, unknown>> = await result.SerialPort.list();
        logSerialDebug('listPorts: real ports raw', raw);
        const mapped: SerialPortInfo[] = raw.map(p => ({
          path: String(p.path ?? ''),
          manufacturer: typeof p.manufacturer === 'string' ? p.manufacturer : undefined,
          vendorId: typeof p.vendorId === 'string' ? p.vendorId : undefined,
          productId: typeof p.productId === 'string' ? p.productId : undefined,
          label: this.formatPortLabel(p),
          virtual: false,
        })).filter(p => p.path);
        logSerial(`listPorts: ${mapped.length} real port(s) detected`);
        return mapped;
      } catch (err) {
        logSerialError('listPorts: SerialPort.list() threw', err);
        return this.getVirtualPortList();
      }
    }
    // Native module not available — provide simulator entries.
    logSerial('listPorts: native serialport unavailable, returning virtual ports');
    return this.getVirtualPortList();
  }

  /**
   * Connect to a port. Uses explicit `open()` (autoOpen=false) so listeners
   * are registered before any event fires, and asserts DTR/RTS so devices
   * like ESP32/CH340/CP2102 leave reset state and start emitting boot logs.
   */
  public async connect(path: string, baudRate: number): Promise<void> {
    if (!path) {
      throw new Error('connect: missing port path');
    }
    if (!baudRate || baudRate <= 0) {
      throw new Error(`connect: invalid baud rate ${baudRate}`);
    }

    if (this.isConnected) {
      if (this.currentPath === path && this.currentBaud === baudRate) {
        logSerial(`connect: already connected to ${path} @ ${baudRate}, no-op`);
        return;
      }
      logSerial(`connect: switching ports — disconnecting ${this.currentPath} first`);
      await this.disconnect();
    }

    const result = await this.getLoadResult();
    const useVirtual = !result.ok || !result.SerialPort;
    const mode: SerialMode = useVirtual ? 'virtual' : 'real';
    this.currentMode = mode;

    logSerial(`connect: opening ${path} @ ${baudRate} (mode=${mode})`);
    this.onStatusEmitter.fire({ kind: 'connecting', path, baud: baudRate, mode });

    try {
      if (useVirtual) {
        await this.openVirtual(path, baudRate);
      } else {
        await this.openReal(result.SerialPort, path, baudRate);
      }
      this.isConnected = true;
      this.currentPath = path;
      this.currentBaud = baudRate;
      logSerial(`connect: opened ${path} (mode=${mode})`);
      this.onDataEmitter.fire({
        data: `\r\n[Embedder Monitor] Connected to ${path} @ ${baudRate} bps (${mode}).\r\n`,
      });
      this.onStatusEmitter.fire({ kind: 'connected', path, baud: baudRate, mode });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logSerialError(`connect: failed to open ${path}`, err);

      // Optional auto-fallback to virtual sim, gated by user setting.
      const fallback = vscode.workspace
        .getConfiguration('embedderMonitor')
        .get<boolean>('fallbackToVirtualOnConnectError', false);

      if (!useVirtual && fallback) {
        logSerial(`connect: real-port open failed, falling back to virtual simulator (per setting)`);
        this.currentMode = 'virtual';
        try {
          await this.openVirtual(path, baudRate);
          this.isConnected = true;
          this.currentPath = path;
          this.currentBaud = baudRate;
          this.onDataEmitter.fire({
            data: `\r\n[Embedder Monitor] Real port failed (${errMsg}). Fallback to VIRTUAL simulator.\r\n`,
          });
          this.onStatusEmitter.fire({ kind: 'connected', path, baud: baudRate, mode: 'virtual' });
          return;
        } catch (innerErr) {
          logSerialError('connect: virtual fallback also failed', innerErr);
        }
      }

      this.onDataEmitter.fire({ data: `\r\n[Embedder Monitor] Open failed: ${errMsg}\r\n` });
      this.onStatusEmitter.fire({ kind: 'error', path, message: errMsg });
      this.onStatusEmitter.fire({ kind: 'disconnected', path, reason: errMsg });
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.currentPort || !this.isConnected) {
      logSerialDebug('disconnect: nothing to do');
      return;
    }
    const path = this.currentPath;
    logSerial(`disconnect: closing ${path}`);
    this.onDataEmitter.fire({ data: `\r\n[Embedder Monitor] Disconnected from ${path}.\r\n` });
    try {
      await new Promise<void>((resolve) => {
        try {
          this.currentPort.close((err: unknown) => {
            if (err) {
              logSerialError(`disconnect: close() callback err`, err);
            }
            resolve();
          });
        } catch (err) {
          logSerialError('disconnect: close threw', err);
          resolve();
        }
      });
    } finally {
      this.currentPort = null;
      this.isConnected = false;
      this.currentPath = '';
      this.currentBaud = 0;
      this.onStatusEmitter.fire({ kind: 'disconnected', path });
    }
  }

  public async send(data: string, newline: string = ''): Promise<void> {
    if (!this.isConnected || !this.currentPort) {
      const msg = 'Not connected to a serial port.';
      logSerialError(`send: ${msg}`);
      throw new Error(msg);
    }

    const payload = data + newline;
    logSerialDebug(`send: ${payload.length} byte(s) → ${this.currentPath}`);
    // Local echo so the operator sees what was sent on the wire.
    this.onDataEmitter.fire({ data: `\r\n> ${payload}` });

    return new Promise<void>((resolve, reject) => {
      try {
        this.currentPort.write(payload, (err: unknown) => {
          if (err) {
            logSerialError(`send: write callback err`, err);
            this.onDataEmitter.fire({
              data: `\r\n[Embedder Monitor] Send Error: ${(err as Error)?.message ?? String(err)}\r\n`,
            });
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (err) {
        logSerialError(`send: write threw`, err);
        reject(err);
      }
    });
  }

  /**
   * Diagnostics summary for `acp.serial.diag` command.
   */
  public diagnose(): string {
    const lines: string[] = [];
    lines.push('--- Embedder Monitor Diagnostics ---');
    lines.push(`Mode:                 ${this.currentMode}`);
    lines.push(`Native serialport:    ${this.isNativeAvailable() ? 'loaded' : 'unavailable'}`);
    if (this.loadResult?.loadError) {
      lines.push(`Native load error:    ${this.loadResult.loadError.message}`);
    }
    lines.push(`Connected:            ${this.isConnected}`);
    lines.push(`Current path:         ${this.currentPath || '-'}`);
    lines.push(`Current baud:         ${this.currentBaud || '-'}`);
    lines.push(`Platform:             ${process.platform}`);
    lines.push(`Node version:         ${process.version}`);
    lines.push('------------------------------------');
    return lines.join('\n');
  }

  public dispose(): void {
    void this.disconnect();
    this.onDataEmitter.dispose();
    this.onStatusEmitter.dispose();
  }

  // -------------------- Internal helpers --------------------

  private async getLoadResult(): Promise<SerialPortLoadResult> {
    if (this.loadResult) {
      return this.loadResult;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('serialport');
      if (mod && mod.SerialPort) {
        this.loadResult = { ok: true, SerialPort: mod.SerialPort };
        logSerial('serialport native module loaded successfully');
      } else {
        const err = new Error('serialport module loaded but SerialPort export missing');
        this.loadResult = { ok: false, loadError: err };
        logSerialError('serialport export check failed', err);
      }
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.loadResult = { ok: false, loadError: e };
      this.currentMode = 'virtual';
      logSerialError('Failed to load native serialport — virtual fallback engaged', e);
    }
    return this.loadResult;
  }

  private async openReal(SerialPortImpl: any, path: string, baudRate: number): Promise<void> {
    const assertControlSignals = vscode.workspace
      .getConfiguration('embedderMonitor')
      .get<boolean>('assertControlSignals', true);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let port: unknown;
      try {
        // autoOpen:false so we can register listeners BEFORE open() fires events.
        port = new SerialPortImpl({ path, baudRate, autoOpen: false });
      } catch (err) {
        logSerialError(`openReal: constructor threw for ${path}`, err);
        reject(err);
        return;
      }
      this.currentPort = port;
      this.attachRealListeners(port, path);

      (port as any).open((err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        if (err) {
          logSerialError(`openReal: open() callback err for ${path}`, err);
          this.currentPort = null;
          reject(err);
          return;
        }
        logSerialDebug(`openReal: open() ok for ${path}, asserting control signals = ${assertControlSignals}`);
        if (assertControlSignals) {
          (port as any).set({ dtr: true, rts: true }, (setErr: unknown) => {
            if (setErr) {
              logSerialError(`openReal: set(DTR/RTS) failed (non-fatal)`, setErr);
            } else {
              logSerialDebug(`openReal: DTR/RTS asserted on ${path}`);
            }
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  private attachRealListeners(port: any, path: string): void {
    port.on('data', (data: Buffer | string) => {
      const strData = Buffer.isBuffer(data) ? data.toString('utf-8') : data;
      logSerialDebug(`onData: ${strData.length} char(s) from ${path}`);
      this.onDataEmitter.fire({ data: strData });
    });

    port.on('error', (err: Error) => {
      logSerialError(`port error on ${path}`, err);
      this.onDataEmitter.fire({ data: `\r\n[Embedder Monitor] Error: ${err.message}\r\n` });
      this.onStatusEmitter.fire({ kind: 'error', path, message: err.message });
    });

    port.on('close', () => {
      logSerial(`port closed: ${path}`);
      const wasConnected = this.isConnected;
      this.isConnected = false;
      this.currentPort = null;
      this.currentPath = '';
      this.currentBaud = 0;
      if (wasConnected) {
        this.onDataEmitter.fire({ data: `\r\n[Embedder Monitor] Port ${path} closed.\r\n` });
        this.onStatusEmitter.fire({ kind: 'disconnected', path, reason: 'port closed' });
      }
    });
  }

  private async openVirtual(path: string, baudRate: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        const sim = new VirtualSerialSimulator({ path, baudRate });
        this.currentPort = sim;
        sim.on('data', (data: Buffer) => {
          const strData = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
          this.onDataEmitter.fire({ data: strData });
        });
        sim.on('close', () => {
          const wasConnected = this.isConnected;
          this.isConnected = false;
          this.currentPort = null;
          this.currentPath = '';
          this.currentBaud = 0;
          if (wasConnected) {
            this.onDataEmitter.fire({ data: `\r\n[Embedder Monitor] Virtual port ${path} closed.\r\n` });
            this.onStatusEmitter.fire({ kind: 'disconnected', path, reason: 'virtual closed' });
          }
        });
        sim.on('open', () => {
          resolve();
        });
        sim.on('error', (err: Error) => {
          logSerialError(`virtual error on ${path}`, err);
          this.onStatusEmitter.fire({ kind: 'error', path, message: err.message });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private getVirtualPortList(): SerialPortInfo[] {
    return [
      { path: 'VSIM1', label: 'VSIM1 — Virtual Simulator', virtual: true },
      { path: 'VSIM2', label: 'VSIM2 — Virtual Simulator', virtual: true },
      { path: 'VSIM3', label: 'VSIM3 — Virtual Simulator', virtual: true },
    ];
  }

  private formatPortLabel(p: Record<string, unknown>): string {
    const path = String(p.path ?? '');
    const manufacturer = typeof p.manufacturer === 'string' ? p.manufacturer : '';
    const friendly = typeof p.friendlyName === 'string' ? p.friendlyName : '';
    const desc = friendly || manufacturer;
    return desc ? `${path} — ${desc}` : path;
  }
}

/**
 * In-process virtual serial port used when the native `serialport` module
 * is unavailable (Webpack target=node + missing prebuilt binary, restricted
 * remote/web environment, ABI mismatch, etc.). Lets the entire ACP +
 * EMBEDDER MONITOR pipeline be exercised end-to-end without any hardware.
 */
// Matches Node EventEmitter listener signature; arg types narrowed by caller.
type SimListener = (...args: any[]) => void;

export class VirtualSerialSimulator {
  private path: string;
  private baudRate: number;
  private listeners: Record<string, SimListener[]> = {};
  private isOpen = false;

  constructor(options: { path: string; baudRate: number }) {
    this.path = options.path;
    this.baudRate = options.baudRate;

    // Simulate async open + initial boot logs.
    setTimeout(() => {
      this.isOpen = true;
      this.emit('open');
      this.emitData(
        `\r\n[Virtual Simulator] Booting device at ${this.path} (${this.baudRate} bps)...\r\n`,
      );
      setTimeout(
        () => this.emitData('[Virtual Simulator] System Ready. Type "help" for commands.\r\n> '),
        150,
      );
    }, 50);
  }

  public on(event: string, callback: SimListener): void {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  public write(data: string, callback?: (err?: Error) => void): void {
    if (!this.isOpen) {
      if (callback) {
        callback(new Error('Port is not open'));
      }
      return;
    }
    // Echo the raw command back so the operator sees activity.
    this.emitData(data);
    setTimeout(() => {
      const cmd = data.trim();
      if (cmd === 'help') {
        this.emitData('Available commands: help, info, status, reboot\r\n> ');
      } else if (cmd === 'info') {
        this.emitData(`Hardware: Virtual Device\r\nPort: ${this.path}\r\n> `);
      } else if (cmd === 'status') {
        this.emitData('Status: All systems operational. Sensors OK.\r\n> ');
      } else if (cmd === 'reboot') {
        this.emitData('Rebooting...\r\n');
        setTimeout(() => this.emitData('\r\n[Virtual Simulator] Booting device...\r\n> '), 800);
      } else if (cmd !== '') {
        this.emitData(`Unknown command: ${cmd}\r\n> `);
      }
      if (callback) {
        callback();
      }
    }, 30);
  }

  public set(_signals: Record<string, boolean>, callback?: (err?: Error) => void): void {
    // Virtual simulator ignores DTR/RTS — accept silently for API parity.
    if (callback) {
      callback();
    }
  }

  public close(callback?: (err?: Error) => void): void {
    this.isOpen = false;
    this.emit('close');
    if (callback) {
      callback();
    }
  }

  private emit(event: string, ...args: unknown[]): void {
    const eventListeners = this.listeners[event];
    if (eventListeners) {
      eventListeners.forEach(cb => {
        try {
          cb(...args);
        } catch {
          // swallow — match EventEmitter semantics for our purposes
        }
      });
    }
  }

  private emitData(str: string): void {
    this.emit('data', Buffer.from(str, 'utf-8'));
  }
}
