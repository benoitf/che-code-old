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

// This file is used by the server and the extensionHost
// For server side, we just load it through a nodejs require
// For extensionHost it's provided through a launch argument

function transformer(remoteAuthority) {

	/**
	 *  @implements {import("./vs/base/common/uriIpc").IRawURITransformer IRawURITransformer}
	 */
	return {
		/**
		 * Incoming
		 * @typedef {import("./vs/base/common/uriIpc").IRawURITransformer IRawURITransformer#transformIncoming}
		 * @param {import("./vs/base/common/uriIpc").UriParts} uri
		 */
		transformIncoming: uri => {
			if (uri.scheme === 'file') {
				return { scheme: 'vscode-local', path: uri.path };
			} else if (uri.scheme === 'vscode-remote') {
				return { scheme: 'file', path: uri.path };
			} else {
				return uri;
			}
		},
		/**
		 * Outgoing
		 * @typedef {import("./vs/base/common/uriIpc").IRawURITransformer IRawURITransformer#transformOutgoing}
		 * @param {import('./vs/base/common/uriIpc').UriParts} uri
		 */
		transformOutgoing: uri => {
			if (uri.scheme === 'file') {
				return { scheme: 'vscode-remote', authority: remoteAuthority, path: uri.path };
			} else if (uri.scheme === 'vscode-local') {
				return { scheme: 'file', path: uri.path };
			} else {
				return uri;
			}
		},
		/**
		 * OutgoingScheme
		 * @typedef {import("./vs/base/common/uriIpc").IRawURITransformer IRawURITransformer#transformOutgoingScheme}
		 * @param {string} scheme
		 */
		transformOutgoingScheme: scheme => {
			if (scheme === 'file') {
				return 'vscode-remote';
			} else if (scheme === 'vscode-local') {
				return 'file';
			} else {
				return scheme;
			}
		}
	};
}

module.exports = transformer;
