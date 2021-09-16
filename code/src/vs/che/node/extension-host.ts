/**********************************************************************
 * Copyright (c) 2021 Red Hat, Inc.
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 ***********************************************************************/
/* eslint-disable header/header */

import { FileAccess } from 'vs/base/common/network';
import * as objects from 'vs/base/common/objects';
import * as platform from 'vs/base/common/platform';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { fork, ChildProcess } from 'child_process';
import { WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { Socket } from 'net';
import { VSCodeProtocolHolder } from 'vs/che/node/ws/vscode-protocol';
import { IExtHostReadyMessage, IExtHostSocketMessage } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { Readable } from 'node:stream';
import { Event } from 'vs/base/common/event';
import { IRemoteConsoleLog } from 'vs/base/common/console';
import { IRemoteExtensionHostStartParams } from 'vs/platform/remote/common/remoteAgentConnection';

/**
 * Starts the extension host
 * @see LocalProcessExtensionHost class
 */
export class ExtensionHost {

	private disposed = false;
	private extensionHostProcess: ChildProcess | undefined;

	constructor(
		private readonly uriTransformerPath: string,
		private socket: Socket,
		private protocolHolder: VSCodeProtocolHolder,
		@INativeEnvironmentService private readonly nativeEnvironmentService: INativeEnvironmentService,
	) {
	}

	async connect(protocolHolder: VSCodeProtocolHolder, debugPort: number | null | undefined): Promise<string> {

		// send debugPort value if provided
		if (debugPort) {
			protocolHolder.sendControlMessage({ debugPort });
		} else {
			protocolHolder.sendControlMessage({});
		}
		const initialDataChunk = Buffer.from(this.protocolHolder.getProtocol().readEntireBuffer().buffer).toString('base64');
		protocolHolder.getProtocol().dispose();
		this.socket.pause();
		return initialDataChunk;
	}

	async reconnect(protocolHolder: VSCodeProtocolHolder, socket: Socket, debugPort: number | null | undefined): Promise<void> {
		if (!this.extensionHostProcess) {
			throw new Error('Extension host process is not defined');
		}
		const initialDataChunk = await this.connect(protocolHolder, debugPort);
		this.protocolHolder = protocolHolder;
		return this.sendExthostIpcSocket(protocolHolder.webSocketNodeSocket, socket, this.extensionHostProcess, initialDataChunk, protocolHolder.getPermessageDeflate());
	}


	async start(startParams: IRemoteExtensionHostStartParams) {

		const initialDataChunk = await this.connect(this.protocolHolder, startParams.port);

		// fixme
		const nlsConfig = {};

		const processEnv: any = { ...process.env };
		// coming from LocalProcessExtensionHost class
		const env = objects.mixin(processEnv, {
			VSCODE_AMD_ENTRYPOINT: 'vs/workbench/services/extensions/node/extensionHostProcess',
			VSCODE_PIPE_LOGGING: 'true',
			VSCODE_VERBOSE_LOGGING: true,
			VSCODE_LOG_NATIVE: false,
			// VSCODE_IPC_HOOK_EXTHOST: pipeName,
			// !! Use websocket communication instead
			VSCODE_EXTHOST_WILL_SEND_SOCKET: true,
			VSCODE_HANDLES_UNCAUGHT_ERRORS: true,
			VSCODE_LOG_STACK: true,
			VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig),
			VSCODE_LOG_LEVEL: this.nativeEnvironmentService.verbose ? 'trace' : this.nativeEnvironmentService.logLevel
		});

		const opts = {
			env,
			// We only detach the extension host on windows. Linux and Mac orphan by default
			// and detach under Linux and Mac create another process group.
			// We detach because we have noticed that when the renderer exits, its child processes
			// (i.e. extension host) are taken down in a brutal fashion by the OS
			detached: !!platform.isWindows,
			execArgv: [] as string[],
			silent: true
		};

		// add exec options if debug is enabled
		if (startParams.port && typeof startParams.port === 'number') {
			opts.execArgv.push(`--inspect${startParams.break ? '-brk' : ''}=0.0.0.0:${startParams.port}`);
		}

		// Run Extension Host as fork of current process
		const extensionHostProcess = fork(FileAccess.asFileUri('bootstrap-fork', require).fsPath, ['--type=extensionHost', `--uriTransformerPath=${this.uriTransformerPath}`], opts);
		this.extensionHostProcess = extensionHostProcess;
		this.protocolHolder.logger.info(`ExtensionHost/pid(${extensionHostProcess.pid}) started`);
		this.updateEncoding(extensionHostProcess.stdout);
		this.updateEncoding(extensionHostProcess.stdout);

		if (extensionHostProcess.stdout) {
			const stdoutEvent = Event.fromNodeEventEmitter(extensionHostProcess.stdout, 'data');
			stdoutEvent(data => {
				this.protocolHolder.logger.info(`ExtensionHost/stdout: ${data}`);
			});
		} else {
			this.protocolHolder.logger.error('ExtensionHost is missing stdout');
		}

		if (extensionHostProcess.stderr) {
			const stderrEvent = Event.fromNodeEventEmitter(extensionHostProcess.stderr, 'data');
			stderrEvent(data => {
				this.protocolHolder.logger.info(`ExtensionHost/stderr: ${data}`);
			});
		} else {
			this.protocolHolder.logger.error('ExtensionHost is missing stderr');
		}

		const onConsoleMessageListener = (msg: IRemoteConsoleLog) => {
			// copy from localProcessExtensionHost
			// Support logging from extension host
			if (msg && (<IRemoteConsoleLog>msg).type === '__$console') {
				// arguments are like ["test.",{"__$stack":"}] so take only first item
				// hide ${msg.type} in the log and also the other arguments like __$stack
				this.protocolHolder.logger.info(`ExtensionHost:console: ${msg.severity}/${JSON.parse(msg.arguments)[0]}`);
			}
		};
		extensionHostProcess.addListener('message', onConsoleMessageListener);

		// we need to handle extensionHostProcessSetup messages
		// remote is saying: Now that we have managed to install a message listener, ask the other side to send us the socket
		// const req: IExtHostReadyMessage = { type: 'VSCODE_EXTHOST_IPC_READY' };
		const onMessageReadyListener = (message: IExtHostReadyMessage) => {

			if (message && message.type === 'VSCODE_EXTHOST_IPC_READY') {
				// if we get there, cancel next message handling
				extensionHostProcess.removeListener('message', onMessageReadyListener);

				// send the websocket to the remoteside
				this.sendExthostIpcSocket(this.protocolHolder.webSocketNodeSocket, this.socket, extensionHostProcess, initialDataChunk, this.protocolHolder.getPermessageDeflate());
			}
		};
		extensionHostProcess.addListener('message', onMessageReadyListener);

		extensionHostProcess.on('exit', (code) => {
			this.protocolHolder.logger.info(`Extension Host Process exited with code ${code}`);
			this.dispose();
		});
		extensionHostProcess.on('error', (err) => {
			this.protocolHolder.logger.error('Extension Host Process error:', err);
			this.dispose();
		});

	}


	updateEncoding(stream: Readable | null): void {
		if (stream) {
			stream.setEncoding('utf8');
		}
	}


	// on exit or error, need to close/dispose all resources
	dispose() {
		// do not do anything if already disposed
		if (this.disposed) {
			return;
		}
		this.disposed = true;

		this.socket.end();
		this.extensionHostProcess?.kill();
	}


	// send VSCODE_EXTHOST_IPC_SOCKET message
	async sendExthostIpcSocket(webSocketNodeSocket: WebSocketNodeSocket, socket: Socket, extensionHostProcess: ChildProcess, initialDataChunk: string, permessageDeflate: boolean): Promise<void> {
		await webSocketNodeSocket.drain();

		// expect from extensionHostProcessSetup something with base64 encoded string
		// decoding being VSBuffer.wrap(Buffer.from(msg.initialDataChunk, 'base64'));
		const recordedInflateBytesBuffer = webSocketNodeSocket.recordedInflateBytes.buffer;
		const inflateBytes = Buffer.from(recordedInflateBytesBuffer).toString('base64');

		const extHostSocketMessage: IExtHostSocketMessage = {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk,
			skipWebSocketFrames: this.protocolHolder.isSkipWebSocketFrames(),
			permessageDeflate,
			inflateBytes
		};
		extensionHostProcess.send(extHostSocketMessage, socket);
	}

}


