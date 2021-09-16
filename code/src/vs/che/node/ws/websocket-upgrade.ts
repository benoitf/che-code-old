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

import * as crypto from 'crypto';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { HeaderParser } from 'vs/che/node/ws/header-parser';
import { NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_CLIENT_MAX_WINDOW_BITS = 15;
/**
 * Do all the stuff of https://datatracker.ietf.org/doc/html/rfc6455
 *
 */
export class WebsocketUpgrade {

	upgradeSocket(req: IncomingMessage, socket: Socket): [WebSocketNodeSocket, boolean] {

		/*
		Concretely, if as in the example above, the |Sec-WebSocket-Key|
		header field had the value "dGhlIHNhbXBsZSBub25jZQ==", the server
		would concatenate the string "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
		to form the string "dGhlIHNhbXBsZSBub25jZQ==258EAFA5-E914-47DA-95CA-
		C5AB0DC85B11".  The server would then take the SHA-1 hash of this,
		giving the value 0xb3 0x7a 0x4f 0x2c 0xc0 0x62 0x4f 0x16 0x90 0xf6
		0x46 0x06 0xcf 0x38 0x59 0x45 0xb2 0xbe 0xc4 0xea.  This value is
		then base64-encoded (see Section 4 of [RFC4648]), to give the value
		"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=".
		*/
		const key =
			req.headers['sec-websocket-key'] !== undefined
				? req.headers['sec-websocket-key'].trim()
				: false;
		const digest = crypto.createHash('sha1').update(key + GUID).digest('base64');

		/*
		The |Connection| and |Upgrade| header fields complete the HTTP
		Upgrade.  The |Sec-WebSocket-Accept| header field indicates whether
		the server is willing to accept the connection.  If present, this
		header field must include a hash of the client's nonce sent in
		|Sec-WebSocket-Key| along with a predefined GUID.  Any other value
		must not be interpreted as an acceptance of the connection by the
		server.

		HTTP/1.1 101 Switching Protocols
		Upgrade: websocket
		Connection: Upgrade
		Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
		*/
		const headers = [
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			`Sec-WebSocket-Accept: ${digest}`
		];

		// parse extensions to see if deflate option is used.
		// delegate parsing
		const headerParser = new HeaderParser();
		const offers = headerParser.parse(req.headers['sec-websocket-extensions']);

		if (offers['permessage-deflate']) {
			offers['permessage-deflate'].map((params: any) => {
				if (params.client_max_window_bits && params.client_max_window_bits[0] === true) {
					params['client_max_window_bits'] = [DEFAULT_CLIENT_MAX_WINDOW_BITS];
				}
			});
			const value = headerParser.format({
				'permessage-deflate': offers['permessage-deflate']
			});
			headers.push(`Sec-WebSocket-Extensions: ${value}`);
		}

		// write headers
		socket.write(headers.concat('\r\n').join('\r\n'));

		const permessageDeflate = !!(offers['permessage-deflate'] || false);
		const websocketNodeSocket = new WebSocketNodeSocket(new NodeSocket(socket), permessageDeflate, null, permessageDeflate);

		return [websocketNodeSocket, permessageDeflate];
	}

}
