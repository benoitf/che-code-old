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

import * as http from 'http';
import { HttpRequestHandler } from 'vs/che/node/http-request-handler';
import { HttpMessage } from 'vs/che/node/http-message';
import { WebsocketHandler } from 'vs/che/node/websocket-handler';
import { IncomingMessage } from 'node:http';
import { Socket } from 'net';
import { ILogService } from 'vs/platform/log/common/log';


export interface HttpServer {
	start(): Promise<void>
}
export const HttpServer = createDecorator<HttpServer>('httpServer');

/**
 * Use VS Code dependency injection to get all services
 */
export class CheHttpServer implements HttpServer {
	constructor(
		private port: number,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@HttpRequestHandler private readonly httpRequestHandler: HttpRequestHandler,
		@WebsocketHandler private readonly websocketHandler: WebsocketHandler,
		@ILogService private readonly logService: ILogService,
	) {
	}


	async start(): Promise<void> {
		const server = http.createServer((req, res) => this.httpRequestHandler.handle(new HttpMessage(req, res)));

		// listening
		server.listen(this.port, () => {
			this.logService.info(`Listening on http://0.0.0.0:${this.port}`);
		});
		// handle errors
		server.on('error', (err: unknown) => {
			this.logService.error('Error', err);
		});

		// handle websocket
		server.on('upgrade', (req: IncomingMessage, socket: Socket) => this.websocketHandler.handle(req, socket, this.instantiationService));
	}

}

