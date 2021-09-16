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

import { CancellationToken } from 'vs/base/common/cancellation';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { RemoteAgentConnectionContext, IRemoteAgentEnvironment } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { Emitter, Event } from 'vs/base/common/event';
import { ILogService } from 'vs/platform/log/common/log';
import * as platform from 'vs/base/common/platform';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import * as path from 'path';
import { URI } from 'vs/base/common/uri';
import { getMarks } from 'vs/base/common/performance';
import { generateUuid } from 'vs/base/common/uuid';
import { ExtensionScanner, ExtensionScannerInput } from 'vs/workbench/services/extensions/node/extensionPoints';
import { IProductService } from 'vs/platform/product/common/productService';
import { IExtensionDescription } from 'vs/platform/extensions/common/extensions';
import { IRawURITransformer, transformOutgoingURIs, URITransformer } from 'vs/base/common/uriIpc';

/**
 * Handle the channel for the remote extension environment
 * @typedef {import('vs/workbench/services/remote/common/remoteAgentEnvironmentChannel').RemoteExtensionEnvironmentChannelClient} RemoteExtensionEnvironmentChannelClient
 * @link RemoteExtensionEnvironmentChannelClient
 *
*/
export class RemoteExtensionEnvironmentChannel implements IServerChannel<RemoteAgentConnectionContext> {

	constructor(private readonly logService: ILogService, private readonly nativeEnvironmentService: INativeEnvironmentService, private readonly productService: IProductService,
		private readonly rawURITransformerFactory: (remoteAuthority: string) => IRawURITransformer,
	) {
	}


	async call<T>(ctx: RemoteAgentConnectionContext, command: string, args?: any, cancellationToken?: CancellationToken): Promise<any> {
		// define the uri transformer
		const rawURITransformer = this.rawURITransformerFactory(args.remoteAuthority);
		const uriTranformer = new URITransformer(rawURITransformer);
		switch (command) {
			// receive for example getEnvironmentData and
			case 'getEnvironmentData':
				// example of args: { remoteAuthority: 'localhost:8080' }
				const os = platform.OS;
				const arch = process.arch;
				const appRoot = URI.file(this.nativeEnvironmentService.appRoot);
				const settingsPath = this.nativeEnvironmentService.settingsResource;
				const logsPath = URI.file(this.nativeEnvironmentService.logsPath);
				const extensionsPath = URI.file(this.nativeEnvironmentService.extensionsPath);
				const extensionHostLogsPath = URI.file(path.join(this.nativeEnvironmentService.logsPath, 'extension-host'));
				const globalStorageHome = this.nativeEnvironmentService.globalStorageHome;
				const workspaceStorageHome = this.nativeEnvironmentService.workspaceStorageHome;
				const userHome = this.nativeEnvironmentService.userHome;
				const marks = getMarks();
				const useHostProxy = false;
				const pid = process.pid;

				// use same approach than reconnectionToken
				const connectionToken = generateUuid();

				// getEnvironmentData expects IRemoteAgentEnvironment
				const remoteAgentEnvironment: IRemoteAgentEnvironment = {
					pid,
					connectionToken,
					appRoot,
					settingsPath,
					logsPath,
					extensionsPath,
					extensionHostLogsPath,
					globalStorageHome,
					workspaceStorageHome,
					userHome,
					os,
					arch,
					marks,
					useHostProxy
				};

				return transformOutgoingURIs(remoteAgentEnvironment, uriTranformer);
			case 'scanExtensions':
				/* example of args:
				{
					language: 'en-US',
					remoteAuthority: 'localhost:8080',
					skipExtensions: []
				}
				*/
				const fakeTranslations = {};
				const language = args.language;
				const builtinExtensionDescriptions: IExtensionDescription[] = await ExtensionScanner.scanExtensions(new ExtensionScannerInput(
					this.productService.version,
					this.productService.date,
					this.productService.commit,
					language,
					true,
					this.nativeEnvironmentService.builtinExtensionsPath,
					true,
					false,
					fakeTranslations,
				), this.logService);

				const extensionDescriptions: IExtensionDescription[] = await ExtensionScanner.scanExtensions(new ExtensionScannerInput(
					this.productService.version,
					this.productService.date,
					this.productService.commit,
					language,
					true,
					this.nativeEnvironmentService.extensionsPath,
					false,
					false,
					fakeTranslations,
				), this.logService);
				const allExtensions = [...builtinExtensionDescriptions, ...extensionDescriptions];
				return transformOutgoingURIs(allExtensions, uriTranformer);
			case 'scanSingleExtension':
				/* example of args:
				{
					language: 'en-US',
					remoteAuthority: 'localhost:8080',
					isBuiltin: false,
					extensionLocation: {
						'$mid': 1,
						path: '/.../extensions/extension-1.0.0',
						scheme: 'vscode-remote',
						authority: 'localhost:8080'
					}
				}
				*/
				const singleFakeTranslations = {};
				const singleLanguage = args.language;
				const singleExtensionDescription: IExtensionDescription | null = await ExtensionScanner.scanSingleExtension(new ExtensionScannerInput(
					this.productService.version,
					this.productService.date,
					this.productService.commit,
					singleLanguage,
					true,
					args.extensionLocation.path,
					true,
					false,
					singleFakeTranslations,
				), this.logService);
				if (!singleExtensionDescription) {
					return undefined;
				}
				return transformOutgoingURIs(singleExtensionDescription, uriTranformer);


		}
		this.logService.error(`RemoteExtensionEnvironmentChannel: unsupported command/${command}`);
		return '';

	}

	listen<T>(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		this.logService.error(`RemoteExtensionEnvironmentChannel: unsupported event/${event}`);
		return new Emitter().event;
	}

}
