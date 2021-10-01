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

import { createDecorator, IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Emitter } from 'vs/base/common/event';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { AuthRequest, ConnectionType, ConnectionTypeRequest, connectionTypeToString, IRemoteExtensionHostStartParams, OKMessage, SignRequest } from 'vs/platform/remote/common/remoteAgentConnection';
import { VSCodeProtocolHolder } from 'vs/che/node/ws/vscode-protocol';
import { ExtensionHost } from 'vs/che/node/extension-host';

import { ClientConnectionEvent } from 'vs/base/parts/ipc/common/ipc';
import { WebsocketUpgrade } from 'vs/che/node/ws/websocket-upgrade';
import { ILogService } from 'vs/platform/log/common/log';
import { parse as parseQuery } from 'querystring';
import { isArray } from 'vs/base/common/types';
import * as url from 'url';
import { VSBuffer } from 'vs/base/common/buffer';
import { IProductService } from 'vs/platform/product/common/productService';
import { IDisposable } from 'vs/workbench/workbench.web.api';
import { LoggerWithPrefix } from 'vs/che/node/logger-prefix';
import { findFreePort } from 'vs/base/node/ports';
import { randomPort } from 'vs/base/common/ports';

export interface WebsocketHandler {
	handle(req: IncomingMessage, socket: Socket, instantiationService: IInstantiationService): void;
}
export const WebsocketHandler = createDecorator<WebsocketHandler>('websocketHandler');

/**
 *  Bind more information from ReconnectionToken
 */
export abstract class AbstractReconnectionTokenDetails {

	constructor(public readonly protocolHolder: VSCodeProtocolHolder) {
	}

}


class ManagementReconnectionDetails extends AbstractReconnectionTokenDetails implements IDisposable {

	public readonly onDidClientDisconnectEmitter = new Emitter<void>();

	private disposed: boolean = false;

	reconnect(protocolHolder: VSCodeProtocolHolder) {
		const protocolToConnect = protocolHolder.getProtocol();
		protocolHolder.sendControlMessage({ type: 'ok' });
		const entireBuffer = protocolToConnect.readEntireBuffer();
		this.protocolHolder.getProtocol().beginAcceptReconnection(protocolToConnect.getSocket(), entireBuffer);
		this.protocolHolder.getProtocol().endAcceptReconnection();
		protocolToConnect.dispose();
	}

	dispose(): void {
		// already done
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		const protocol = this.protocolHolder.getProtocol();
		const socket = protocol.getSocket();
		protocol.sendDisconnect();
		protocol.dispose();
		socket.end();
	}


}


/**
 * Handle the websockets
 *
 */
export class CheWebsocketHandler implements WebsocketHandler {

	private websocketUpgrade: WebsocketUpgrade;

	private extensionHostConnections: Map<string, ExtensionHostReconnectionDetails>;
	private managementConnections: Map<string, ManagementReconnectionDetails>;


	constructor(private onDidClientConnectEmitter: Emitter<ClientConnectionEvent>,
		private readonly uriTransformerPath: string,
		@ILogService private readonly logService: ILogService,
		@IProductService private readonly productService: IProductService,
	) {
		this.websocketUpgrade = new WebsocketUpgrade();
		this.extensionHostConnections = new Map<string, ExtensionHostReconnectionDetails>();
		this.managementConnections = new Map<string, ManagementReconnectionDetails>();
	}

	async handle(req: IncomingMessage, socket: Socket, instantiationService: IInstantiationService): Promise<void> {
		// handle the request upgrade
		const [websocketNodeSocket, permessageDeflate] = this.websocketUpgrade.upgradeSocket(req, socket);

		// check if we have reconnectionToken settings
		const urlQuery = url.parse(req.url || '');
		const parsedQuery = parseQuery(urlQuery.query || '');
		const reconnectionToken = parsedQuery.reconnectionToken;

		// query parameters
		const reconnection = parsedQuery.reconnection === 'true';
		const skipWebSocketFrames = parsedQuery.skipWebSocketFrames === 'true';


		// Log prefix
		const prefix = reconnectionToken && typeof reconnectionToken === 'string' ? `Token[${reconnectionToken.substr(0, 8)}]` : `Token[unknown/${reconnectionToken}]`;
		const loggerWithPrefix = new LoggerWithPrefix(this.logService, prefix);

		loggerWithPrefix.info(`query reconnecting/${reconnection} skipWebSocketFrames/${skipWebSocketFrames} permessageDeflate/${permessageDeflate}`);

		// reconnectionToken should be a single query parameter
		if (!reconnectionToken || isArray(reconnectionToken)) {
			// send error on the socket
			// https://nodejs.org/api/http.html#http_event_clienterror
			socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
			return;
		}

		// Protocol used by VS Code over the websocket
		const protocolHolder = new VSCodeProtocolHolder(websocketNodeSocket, reconnection, reconnectionToken, permessageDeflate, skipWebSocketFrames, loggerWithPrefix);

		protocolHolder.getProtocol().onControlMessage(controlMessage => {
			const jsonControlMessage = JSON.parse(controlMessage.toString());
			if (jsonControlMessage.type === 'auth') {
				// Auth request
				this.handleAuthRequest(jsonControlMessage, protocolHolder);
			} else if (jsonControlMessage.type === 'connectionType') {
				// ConnectionType request
				this.handleConnectionTypeRequest(jsonControlMessage, protocolHolder, instantiationService, socket);
			}
		});
	}


	handleAuthRequest(authRequest: AuthRequest, protocolHolder: VSCodeProtocolHolder): void {
		const signRequest: SignRequest = {
			type: 'sign',
			data: '',
		};
		protocolHolder.sendControlMessage(signRequest);
	}

	async handleConnectionTypeRequest(connectionTypeRequest: ConnectionTypeRequest, protocolHolder: VSCodeProtocolHolder, instantiationService: IInstantiationService,
		socket: Socket): Promise<void> {
		protocolHolder.logger.info(`Handling ${connectionTypeToString(connectionTypeRequest.desiredConnectionType!)} request`);

		const clientCommit = connectionTypeRequest.commit;
		const productCommit = this.productService.commit;
		if (clientCommit !== productCommit) {
			protocolHolder.logger.error(`Client commitID ${clientCommit} is not matching product commit id ${productCommit}`);
			// allow any client
			// return this.abortWebSocketConnection(protocolHolder, 'Client is not matching server');
		}

		switch (connectionTypeRequest.desiredConnectionType) {
			case ConnectionType.Management:

				// grab existing connection if it exists
				let managementConnectionDetails = this.managementConnections.get(protocolHolder.reconnectionToken);

				// Client ask to reconnect but we don't have stored any such connection for the token
				// so throw an error
				if (!managementConnectionDetails && protocolHolder.isReconnecting() === true) {
					return this.abortWebSocketConnection(protocolHolder, 'Asking to reconnect but provided token is unknown');
				}
				// not there before, add it
				if (!managementConnectionDetails) {
					managementConnectionDetails = new ManagementReconnectionDetails(protocolHolder);
					this.managementConnections.set(protocolHolder.reconnectionToken, managementConnectionDetails);
					this.onDidClientConnectEmitter.fire({ protocol: protocolHolder.getProtocol(), onDidClientDisconnect: managementConnectionDetails.onDidClientDisconnectEmitter.event });
				} else {
					protocolHolder.logger.info('Reuse previous management connection');
					managementConnectionDetails.reconnect(protocolHolder);
				}
				break;
			case ConnectionType.ExtensionHost:

				const remoteExtensionHostStartParams: IRemoteExtensionHostStartParams = { language: 'en', ...connectionTypeRequest.args };

				// grab existing connection or create a new one
				let extensionHostConnectionDetails = this.extensionHostConnections.get(protocolHolder.reconnectionToken);

				// reconnecting but not found, error
				if (!extensionHostConnectionDetails && protocolHolder.isReconnecting() === true) {
					protocolHolder.logger.error('Reconnecting but no previous connection has been found. Aborting.');
					return this.abortWebSocketConnection(protocolHolder, 'Reconnecting but no previous connection has been found. Aborting.');
				}

				// we have previous details, use it

				if (extensionHostConnectionDetails) {

					// grab current information and reconnect if the extension host is already started
					const extensionHostProcess = extensionHostConnectionDetails.getExtensionHost();
					if (!extensionHostProcess) {
						return this.abortWebSocketConnection(protocolHolder, 'Extension host is not defined');
					}
					// reconnect to this extension host
					try {
						protocolHolder.logger.info('Reconnecting from a previous instance...');
						return extensionHostProcess.reconnect(protocolHolder, socket, extensionHostConnectionDetails.remoteStartParams.port || 0);
					} catch (error) {
						return this.abortWebSocketConnection(protocolHolder, error.message);
					}
				}

				// if there, it's a fresh connection. Store it and start the extension host
				extensionHostConnectionDetails = new ExtensionHostReconnectionDetails(protocolHolder, remoteExtensionHostStartParams);
				protocolHolder.logger.info('New connection to ExtensionHost');
				this.extensionHostConnections.set(protocolHolder.reconnectionToken, extensionHostConnectionDetails);

				// remove the details when client disconnects
				extensionHostConnectionDetails.onDidClientDisconnectEmitter.event(() => {
					protocolHolder.logger.info('Remove the extensionHost connection as client disconnected');
					this.extensionHostConnections.delete(protocolHolder.reconnectionToken);
				});

				// before starting the extension host, validate the debug port parameter
				await this.validateDebugPort(remoteExtensionHostStartParams, protocolHolder);

				// instantiate the extension host process
				const extensionHost = instantiationService.createInstance(ExtensionHost, this.uriTransformerPath, socket, protocolHolder);

				// store the instance in the details
				extensionHostConnectionDetails.setExtensionHost(extensionHost);
				await extensionHost.start(remoteExtensionHostStartParams);
				break;
			case ConnectionType.Tunnel:
				protocolHolder.logger.error('Noop for tunnel connection');
				break;
		}
		const okMessage: OKMessage = { type: 'ok' };
		protocolHolder.sendControlMessage(okMessage);

	}

	async abortWebSocketConnection(protocolHolder: VSCodeProtocolHolder, reason: string): Promise<void> {
		protocolHolder.logger.warn(`Aborting connection: ${reason}.`);

		const errorMessage = {
			reason,
			type: 'error',
		};

		const persistentProtocol = protocolHolder.getProtocol();
		// send back the error to client
		persistentProtocol.sendControl(VSBuffer.fromString(JSON.stringify(errorMessage)));
		// dispose
		persistentProtocol.dispose();

		// clean websocket
		await persistentProtocol.getSocket().drain();
		persistentProtocol.getSocket().dispose();
	}


	protected async validateDebugPort(remoteExtensionHostStartParams: IRemoteExtensionHostStartParams, protocolHolder: VSCodeProtocolHolder): Promise<IRemoteExtensionHostStartParams> {
		if (remoteExtensionHostStartParams.port === 0) {
			// extract port retrieval from cli
			const debugPort = await findFreePort(randomPort(), 10, 6000);
			protocolHolder.logger.info(`Picking up debugPort ${debugPort}`);
			remoteExtensionHostStartParams.port = debugPort;
		}
		return remoteExtensionHostStartParams;
	}
}

class ExtensionHostReconnectionDetails extends AbstractReconnectionTokenDetails {

	private extensionHost: ExtensionHost | undefined;
	private disposed: boolean = false;
	public readonly onDidClientDisconnectEmitter = new Emitter<void>();

	constructor(protocolHolder: VSCodeProtocolHolder, public readonly remoteStartParams: IRemoteExtensionHostStartParams) {
		super(protocolHolder);
	}

	setExtensionHost(extensionHost: ExtensionHost) {
		this.extensionHost = extensionHost;
	}

	getExtensionHost(): ExtensionHost | undefined {
		return this.extensionHost;
	}


	dispose(): void {
		// already done
		if (this.disposed) {
			return;
		}
		// dispose the extension host
		if (this.extensionHost) {
			this.extensionHost.dispose();
			this.extensionHost = undefined;
		}

		this.onDidClientDisconnectEmitter.fire();

	}



}
