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

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { HttpMessage } from 'vs/che/node/http-message';
import * as path from 'path';
import { promises as fs } from 'fs';

export interface HttpRequestHandler {
	handle(message: HttpMessage): void;
}
export const HttpRequestHandler = createDecorator<HttpRequestHandler>('httpRequestHandler');

/**
 * Handle the http requests
 * @see code-web.js
 */
export class CheHttpRequestHandler implements HttpRequestHandler {

	private static readonly APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
	private static readonly WORKBENCH_DEV = path.join(CheHttpRequestHandler.APP_ROOT, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench-dev.html');
	private static readonly WORKBENCH = path.join(CheHttpRequestHandler.APP_ROOT, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html');

	async handle(message: HttpMessage): Promise<void> {

		// validate content
		if (!message.validate()) {
			return;
		}


		if (/(\/static)?\/favicon\.ico/.test(message.path())) {
			// favicon
			// FIXME: use a che icon
			return message.serveFile(path.join(CheHttpRequestHandler.APP_ROOT, 'resources', 'win32', 'code.ico'));
		}
		if (/(\/static)?\/manifest\.json/.test(message.path())) {
			// manifest

			return message.okJsonObject({
				'name': 'Eclipse Che',
				'short_name': 'Eclipse Che',
				'start_url': '/',
				'lang': 'en-US',
				'display': 'standalone'
			});
		}

		if (message.path() === '/') {
			// main web
			return this.handleRoot(message);
		}
		if (/^\/static\//.test(message.path())) {
			// static requests
			return this.handleStatic(message);
		}

		if (/^\/vscode-remote-resource/.test(message.path())) {
			// remote resources
			return this.handleRemoteResource(message);
		}

		/*
		if (/^\/extension\//.test(pathname)) {
			// default extension requests
			return handleExtension(req, res, parsedUrl);
		}*/

		console.error('Not matching any request for', message.path());
		message.error400('no matching request');

	}

	escapeAttribute(value: string) {
		return value.replace(/"/g, '&quot;');
	}

	async handleRemoteResource(message: HttpMessage): Promise<void> {
		const queryPath = message.queryPath();

		// should be only of type string
		if (!queryPath || typeof queryPath !== 'string') {
			message.error400('invalid query path');
			return;
		}
		const queryPathString: string = queryPath;
		return message.serveFile(queryPathString);
	}

	async handleStatic(message: HttpMessage): Promise<void> {

		// will uncomment when working on extensions
		/*if (/^\/static\/extensions\//.test(message.path())) {
			const relativePath = decodeURIComponent(message.path().substr('/static/extensions/'.length));
			// const filePath = getExtensionFilePath(relativePath, (await builtInExtensionsPromise).locations);
			const responseHeaders = {};
			//if (addCORSReplyHeader(req)) {
			//	responseHeaders['Access-Control-Allow-Origin'] = '*';
			//}
			//if (!filePath) {
			//	return serveError(req, res, 400, `Bad request.`, responseHeaders);
			//}
			return serveFile(req, res, filePath, responseHeaders);
		}*/

		// Strip `/static/` from the path
		const relativeFilePath = path.normalize(decodeURIComponent(message.path().substr('/static/'.length)));
		return message.serveFile(path.join(CheHttpRequestHandler.APP_ROOT, relativeFilePath));

	}

	async handleRoot(message: HttpMessage): Promise<void> {

		/*const secondaryHost = (
			req.headers['host']
				? req.headers['host'].replace(':' + PORT, ':' + SECONDARY_PORT)
				: `${HOST}:${SECONDARY_PORT}`
		);*/
		// provides only remote authority
		const webConfigJSON = {
			// folderUri: folderUri,
			// additionalBuiltinExtensions,
			remoteAuthority: message.getRemoteAuthority(),
			"welcomeBanner": {
				"message": "CheCode",
				"actions": [
					{
						"href": "https://github.com/eclipse-che/code",
						"label": "Use Code inside Eclipse Che"
					}
				]
			},
			// webWorkerExtensionHostIframeSrc: `${SCHEME}://${secondaryHost}/static/out/vs/workbench/services/extensions/worker/httpWebWorkerExtensionHostIframe.html`
		};

		let workbenchFile;
		if (process.env['VSCODE_DEV']) {
			workbenchFile = CheHttpRequestHandler.WORKBENCH_DEV;
		} else {
			workbenchFile = CheHttpRequestHandler.WORKBENCH;
		}

		const webContent = await fs.readFile(workbenchFile, 'utf-8');
		const data = webContent
			.replace('{{WORKBENCH_WEB_CONFIGURATION}}', () => this.escapeAttribute(JSON.stringify(webConfigJSON))) // use a replace function to avoid that regexp replace patterns ($&, $0, ...) are applied
			.replace('{{WORKBENCH_BUILTIN_EXTENSIONS}}', () => this.escapeAttribute(JSON.stringify([])))
			.replace('{{WORKBENCH_AUTH_SESSION}}', () => '')
			.replace('{{WEBVIEW_ENDPOINT}}', '');

		const headers = {
			'Content-Type': 'text/html',
			'Content-Security-Policy': 'require-trusted-types-for \'script\';'
		};
		message.ok(data, headers);
	}

}
