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

import { IPCServer } from 'vs/base/parts/ipc/common/ipc';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILoggerService, ILogService } from 'vs/platform/log/common/log';
import { Disposable } from 'vs/base/common/lifecycle';
import { LoggerChannel, LogLevelChannel } from 'vs/platform/log/common/logIpc';
import { setUnexpectedErrorHandler, onUnexpectedError } from 'vs/base/common/errors';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { ExtensionGalleryServiceWithNoStorageService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { InjectedDiskFileSystemProviderDecorator, RemoteFileSystemChannel } from 'vs/che/node/channels/remote-filesystem-channel';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { REMOTE_TERMINAL_CHANNEL_NAME } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { RemoteTerminalChannel } from 'vs/che/node/channels/remote-terminal-channel';
import { RemoteExtensionEnvironmentChannel } from 'vs/che/node/channels/remote-extension-environment-channel';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { IRawURITransformer, URITransformer } from 'vs/base/common/uriIpc';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { DownloadService } from 'vs/platform/download/common/downloadService';
import { RequestService } from 'vs/platform/request/node/requestService';
import { IDownloadService } from 'vs/platform/download/common/download';
import { IRequestService } from 'vs/platform/request/common/request';
import { IProductService } from 'vs/platform/product/common/productService';
import * as path from 'path';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';

/**
 * Starts the Che Server (which is similar to CodeApplication class)
 * https://github.com/microsoft/vscode/blob/f48865014d0ef5ef88da118b62911b95b971dcc1/src/vs/code/electron-main/app.ts
 * Register listeners, services and then register channels
 */
export class CheApplication extends Disposable {

	constructor(
		private readonly mainProcessNodeIpcServer: IPCServer<RemoteAgentConnectionContext>,
		@IInstantiationService private readonly mainInstantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentMainService: INativeEnvironmentService,
	) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {

		// We handle uncaught exceptions here to prevent electron from opening a dialog to the user
		setUnexpectedErrorHandler(err => this.onUnexpectedError(err));
		process.on('uncaughtException', err => this.onUnexpectedError(err));
		process.on('unhandledRejection', (reason: unknown) => onUnexpectedError(reason));

	}

	private onUnexpectedError(err: Error): void {
		this.logService.error(`[uncaught exception in main]: ${err}`);
		if (err.stack) {
			this.logService.error(err.stack);
		}
	}

	async startup(): Promise<void> {
		this.logService.debug('Starting CheCode');
		this.logService.debug(`from: ${this.environmentMainService.appRoot}`);
		this.logService.debug('args:', this.environmentMainService.args);

		// Services
		this.logService.trace('init services...');
		const appInstantiationService = await this.initServices();
		this.logService.trace('end init services');


		// Setup Auth Handler
		// this._register(appInstantiationService.createInstance(ProxyAuthHandler));

		// Init Channels
		this.logService.trace('init channels...');
		appInstantiationService.invokeFunction(accessor => this.initChannels(accessor, this.mainProcessNodeIpcServer));
		this.logService.trace('end init channels');
	}

	private async initServices(): Promise<IInstantiationService> {
		const services = new ServiceCollection();
		services.set(ITelemetryService, NullTelemetryService);

		services.set(IDownloadService, new SyncDescriptor(DownloadService));
		services.set(IRequestService, new SyncDescriptor(RequestService));


		// Grab from cliProcessMain.js
		// Extensions
		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryServiceWithNoStorageService));

		// Localizations
		services.set(ILocalizationsService, new SyncDescriptor(LocalizationsService));


		return this.mainInstantiationService.createChild(services);
	}



	private initChannels(accessor: ServicesAccessor, ipcServer: IPCServer<RemoteAgentConnectionContext>): void {

		// Log Level (main & shared process)
		const logLevelChannel = new LogLevelChannel(accessor.get(ILogService));
		ipcServer.registerChannel('logLevel', logLevelChannel);

		// Logger
		const loggerChannel = new LoggerChannel(accessor.get(ILoggerService),);
		ipcServer.registerChannel('logger', loggerChannel);

		// need to configure the uri transformer
		// copy from extensionHostProcessSetup.ts
		const uriTransformerPath = path.join(__dirname, './che-uri-transformer');
		const rawURITransformerFactory = <(remoteAuthority: string) => IRawURITransformer>require.__$__nodeRequire(uriTransformerPath);

		// @see AbstractRemoteAgentService for all remote stuff

		// remote filesystem
		ipcServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new RemoteFileSystemChannel(accessor.get(InjectedDiskFileSystemProviderDecorator), accessor.get(ILogService), rawURITransformerFactory));

		// remote terminal
		ipcServer.registerChannel(REMOTE_TERMINAL_CHANNEL_NAME, new RemoteTerminalChannel(accessor.get(ILogService)));

		// remote extensionsenvironment
		ipcServer.registerChannel('remoteextensionsenvironment', new RemoteExtensionEnvironmentChannel(accessor.get(ILogService), accessor.get(INativeEnvironmentService), accessor.get(IProductService), rawURITransformerFactory));

		// extensionhostdebugservice
		ipcServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());


		// register extensions
		ipcServer.registerChannel('extensions', new ExtensionManagementChannel(accessor.get(IExtensionManagementService), (ctx) => new URITransformer(rawURITransformerFactory(ctx.remoteAuthority))));

	}



}
