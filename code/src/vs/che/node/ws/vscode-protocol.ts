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

import { VSBuffer } from 'vs/base/common/buffer';
import { PersistentProtocol } from 'vs/base/parts/ipc/common/ipc.net';
import { WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { LoggerWithPrefix } from 'vs/che/node/logger-prefix';
import { OKMessage, SignRequest } from 'vs/platform/remote/common/remoteAgentConnection';

/**
 * Hold protocol and related objects
 * Also have some helper methods to send JSON message and not have to wrap to VS Buffer every time
 */
export class VSCodeProtocolHolder {


	public readonly reconnectionTokenHash: string;
	private persistentProtocol: PersistentProtocol;

	constructor(
		public readonly webSocketNodeSocket: WebSocketNodeSocket,
		private reconnection: boolean,
		public readonly reconnectionToken: string,
		private permessageDeflate: boolean,
		private skipWebSocketFrames: boolean,
		public readonly logger: LoggerWithPrefix,

	) {
		this.persistentProtocol = new PersistentProtocol(webSocketNodeSocket);
		// first 8 digits of sha256 hash of the reconnection token
		this.reconnectionTokenHash = reconnectionToken.substr(0, 8);
	}

	getProtocol(): PersistentProtocol {
		return this.persistentProtocol;
	}


	getPermessageDeflate(): boolean {
		return this.permessageDeflate;
	}

	sendControlMessage(request: SignRequest | OKMessage | any) {
		this.persistentProtocol.sendControl(VSBuffer.fromString(JSON.stringify(request)));
	}

	public isReconnecting() {
		return this.reconnection === true;
	}

	public isSkipWebSocketFrames() {
		return this.skipWebSocketFrames;
	}


}
