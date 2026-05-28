import * as assert from 'assert';
import * as vscode from 'vscode';
import { VirtualSerialSimulator } from '../core/SerialManager';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('formulahendry.acp-client'));
	});

	test('Should activate extension', async () => {
		const ext = vscode.extensions.getExtension('formulahendry.acp-client');
		assert.ok(ext);
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('Should register ACP commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		const acpCommands = commands.filter(c => c.startsWith('acp.'));
		assert.ok(acpCommands.length > 0, 'ACP commands should be registered');
		assert.ok(acpCommands.includes('acp.connectAgent'), 'connectAgent command should exist');
		assert.ok(acpCommands.includes('acp.newConversation'), 'newConversation command should exist');
		assert.ok(acpCommands.includes('acp.openChat'), 'openChat command should exist');
		assert.ok(acpCommands.includes('acp.serial.diag'), 'serial.diag command should exist');
	});
});

suite('VirtualSerialSimulator', () => {
	test('emits open + initial boot data, echoes write, responds to help', async function () {
		this.timeout(4000);

		const sim = new VirtualSerialSimulator({ path: 'VSIM1', baudRate: 115200 });

		// Wait for 'open' to fire.
		await new Promise<void>((resolve) => sim.on('open', () => resolve()));

		// Collect data until we see the System Ready prompt.
		const chunks: string[] = [];
		await new Promise<void>((resolve) => {
			sim.on('data', (buf: Buffer) => {
				chunks.push(buf.toString('utf-8'));
				if (chunks.join('').includes('System Ready')) {
					resolve();
				}
			});
		});
		const bootLog = chunks.join('');
		assert.ok(bootLog.includes('Booting device'), 'boot banner should appear');
		assert.ok(bootLog.includes('VSIM1'), 'boot banner should mention the port path');

		// Issue `help` and wait for response.
		const responseChunks: string[] = [];
		const helpResponse = new Promise<string>((resolve) => {
			sim.on('data', (buf: Buffer) => {
				responseChunks.push(buf.toString('utf-8'));
				const combined = responseChunks.join('');
				if (combined.includes('Available commands')) {
					resolve(combined);
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			sim.write('help\n', (err) => (err ? reject(err) : resolve()));
		});
		const response = await helpResponse;
		assert.ok(response.includes('help'), 'echo of typed command should appear');
		assert.ok(response.includes('Available commands'), 'help should return command list');
	});

	test('set() with DTR/RTS resolves silently on virtual port', async () => {
		const sim = new VirtualSerialSimulator({ path: 'VSIM2', baudRate: 9600 });
		await new Promise<void>((resolve) => sim.on('open', () => resolve()));
		await new Promise<void>((resolve, reject) => {
			sim.set({ dtr: true, rts: true }, (err) => (err ? reject(err) : resolve()));
		});
	});
});
