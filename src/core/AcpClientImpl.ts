import type {
  Client,
  Agent,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';

import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { log, logError } from '../utils/Logger';

import { SerialManager } from './SerialManager';

/**
 * ACP Client implementation for VS Code.
 * Delegates to individual handlers for each capability.
 *
 * Passed as a factory to ClientSideConnection:
 *   new ClientSideConnection((agent) => new AcpClientImpl(...), stream)
 */
export class AcpClientImpl implements Client {
  private agent: Agent | null = null;
  private serialDataListener?: { dispose: () => void };

  constructor(
    private readonly fsHandler: FileSystemHandler,
    private readonly terminalHandler: TerminalHandler,
    private readonly permissionHandler: PermissionHandler,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
    private readonly serialManager: SerialManager,
  ) {
    // Subscribe to serial data and push it to the agent
    this.serialDataListener = this.serialManager.onData((e) => {
      if (this.agent && this.agent.extNotification) {
        this.agent.extNotification('acp:serial_data', { data: e.data }).catch((err) => {
          logError('Failed to send serial data notification to agent', err);
        });
      }
    });
  }

  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  getAgent(): Agent | null {
    return this.agent;
  }

  dispose(): void {
    if (this.serialDataListener) {
      this.serialDataListener.dispose();
    }
  }

  // --- Extension methods for Serial Port ---
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (method) {
      case 'acp:serial_connect': {
        const port = params.port as string;
        const baud = params.baud as number;
        if (!port || !baud) {
          throw new Error('Missing port or baud rate');
        }
        await this.serialManager.connect(port, baud);
        return { success: true };
      }
      case 'acp:serial_disconnect': {
        await this.serialManager.disconnect();
        return { success: true };
      }
      case 'acp:serial_write': {
        const data = params.data as string;
        const newline = (params.newline as string) || '';
        if (data === undefined) {
          throw new Error('Missing data to write');
        }
        await this.serialManager.send(data, newline);
        return { success: true };
      }
      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  // --- Required methods ---

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.permissionHandler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.sessionUpdateHandler.handleUpdate(params);
  }

  // --- File system methods ---

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    log(`Client.writeTextFile: ${params.path}`);
    return this.fsHandler.writeTextFile(params);
  }

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    log(`Client.readTextFile: ${params.path}`);
    return this.fsHandler.readTextFile(params);
  }

  // --- Terminal methods ---

  async createTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    return this.terminalHandler.createTerminal(params);
  }

  async terminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return this.terminalHandler.terminalOutput(params);
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return this.terminalHandler.waitForTerminalExit(params);
  }

  async killTerminal(
    params: KillTerminalRequest,
  ): Promise<KillTerminalResponse> {
    return this.terminalHandler.killTerminal(params);
  }

  async releaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return this.terminalHandler.releaseTerminal(params);
  }
}
