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

import { IncomingMessage, OutgoingHttpHeader, ServerResponse } from 'node:http';
import * as url from 'url';
import * as path from 'path';
import * as util from 'util';
import * as fs from 'fs';
import { OutgoingHttpHeaders } from 'http';
import { ParsedUrlQuery } from 'node:querystring';

/**
 * Http Messsage provides helper functions to send response to the incoming requests
 */
export class HttpMessage {

	// mapped to textMimeType in code-web.js
	private static readonly TEXT_MIME_TYPES: { [name: string]: string } = {
		'.html': 'text/html',
		'.js': 'text/javascript',
		'.json': 'application/json',
		'.css': 'text/css',
		'.svg': 'image/svg+xml',
	};

	// mapped to mapExtToMediaMimes in code-web.js
	private static readonly MAP_EXT_TO_MEDIA_MIMES: { [name: string]: string } = {
		'.bmp': 'image/bmp',
		'.gif': 'image/gif',
		'.ico': 'image/x-icon',
		'.jpe': 'image/jpg',
		'.jpeg': 'image/jpg',
		'.jpg': 'image/jpg',
		'.png': 'image/png',
		'.tga': 'image/x-tga',
		'.tif': 'image/tiff',
		'.tiff': 'image/tiff',
		'.woff': 'application/font-woff'
	};

	private pathname: string = '';
	private query: ParsedUrlQuery = {};

	constructor(private req: IncomingMessage, private res: ServerResponse) {

	}

	validate(): boolean {
		if (!this.req.url) {
			this.error400('missing url parameter');
			return false;
		}

		const parsedUrl = url.parse(this.req.url, true);

		if (!parsedUrl.pathname) {
			this.error400('missing pathname');
			return false;
		}
		this.pathname = parsedUrl.pathname;
		this.query = parsedUrl.query;
		return true;

	}

	error400(errorMessage?: string) {
		this.error(400, errorMessage);
	}

	error304(errorMessage?: string) {
		this.error(304, errorMessage);
	}

	error404(errorMessage?: string) {
		this.error(404, errorMessage);
	}

	error(errorCode: number, errorMessage?: string) {
		this.res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
		this.res.end(errorMessage);
	}

	okJsonObject(object: unknown): void {
		this.res.writeHead(200, { 'Content-Type': 'application/json' });
		this.res.end(JSON.stringify(object));
	}

	ok(content: unknown, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]) {
		this.res.writeHead(200, headers);
		return this.res.end(content);

	}

	path() {
		return this.pathname;
	}

	queryPath() {
		return this.query['path'];
	}

	getMediaMime(forPath: string): string | undefined {
		const ext = path.extname(forPath);
		return HttpMessage.MAP_EXT_TO_MEDIA_MIMES[ext.toLowerCase()];
	}

	getRemoteAuthority() {
		const xForwardedProto = this.req.headers['x-forwarded-proto'];
		const host = this.req.headers.host;
		if (xForwardedProto === 'https' && host && host.indexOf(':') === -1) {
			return `${host}:443`;
		} else {
			return this.req.headers.host;
		}
	}


	async serveFile(filePath: string, responseHeaders = Object.create(null)): Promise<void> {

		try {

			// Sanity checks
			filePath = path.normalize(filePath); // ensure no "." and ".."
			const stat = await util.promisify(fs.stat)(filePath);

			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			if (this.req.headers['if-none-match'] === etag) {
				this.error304();
				return;
			}

			// Headers
			responseHeaders['Content-Type'] = HttpMessage.TEXT_MIME_TYPES[path.extname(filePath)] || this.getMediaMime(filePath) || 'text/plain';
			responseHeaders['Etag'] = etag;

			this.res.writeHead(200, responseHeaders);

			// Data
			fs.createReadStream(filePath).pipe(this.res);
		} catch (error) {
			console.error(error.toString());
			responseHeaders['Content-Type'] = 'text/plain';
			this.error404();
		}
	}


}
