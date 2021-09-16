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

import { CheHttpRequestHandler, HttpRequestHandler } from 'vs/che/node/http-request-handler';
import { isWindows, isMacintosh } from 'vs/base/common/platform';
import { localize } from 'vs/nls';
import { CheHttpServer, HttpServer } from 'vs/che/node/http-server';
import { CheWebsocketHandler, WebsocketHandler } from 'vs/che/node/websocket-handler';
import { IEnvironmentService, INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { NativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { addArg, parseMainProcessArgv } from 'vs/platform/environment/node/argvHelper';
import { IProductService } from 'vs/platform/product/common/productService';
import product from 'vs/platform/product/common/product';
import { BufferLogService } from 'vs/platform/log/common/bufferLog';
import { ConsoleMainLogger, getLogLevel, ILoggerService, ILogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { ExpectedError, setUnexpectedErrorHandler } from 'vs/base/common/errors';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { createWaitMarkerFile } from 'vs/platform/environment/node/wait';
import { basename, resolve } from 'vs/base/common/path';
import { IPathWithLineAndColumn, isValidBasename, parseLineAndColumnAware, sanitizeFilePath } from 'vs/base/common/extpath';
import { coalesce, distinct } from 'vs/base/common/arrays';
import { rtrim, trim } from 'vs/base/common/strings';
import { FileService } from 'vs/platform/files/common/fileService';
import { IFileService } from 'vs/platform/files/common/files';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { Schemas } from 'vs/base/common/network';
import { LoggerService } from 'vs/platform/log/node/loggerService';
import { Promises } from 'vs/base/node/pfs';
import { Emitter } from 'vs/base/common/event';
import { ClientConnectionEvent, IPCServer } from 'vs/base/parts/ipc/common/ipc';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService, ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { getPathLabel } from 'vs/base/common/labels';
import { toErrorMessage } from 'vs/base/common/errorMessage';

import { XDG_RUNTIME_DIR } from 'vs/base/parts/ipc/node/ipc.net';
import { CheApplication } from 'vs/che/node/che-application';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { InjectedDiskFileSystemProviderDecorator } from 'vs/che/node/channels/remote-filesystem-channel';
import * as path from 'path';

// Setup the dependency inection system
// based on https://github.com/microsoft/vscode/blob/71be3b3641329d5f22b54f9223deba436b47ee03/src/vs/code/electron-main/main.ts
export class CheInstantiationServiceSetup {


	private onDidClientConnectEmitter = new Emitter<ClientConnectionEvent>();

	public async startup(): Promise<IInstantiationService> {

		// Set the error handler early enough so that we are not getting the
		// default electron error dialog popping up
		setUnexpectedErrorHandler(err => console.error(err));

		// Resolve command line arguments
		const args = this.resolveArgs();

		// add open-vsx as extensionGallery
		// Issue with CORS on server side for openvsx https://github.com/eclipse/openvsx/issues/306
		(product as any).extensionsGallery = {
			serviceUrl: 'https://open-vsx.org/vscode/gallery',
			itemUrl: 'https://open-vsx.org/vscode/item',
		};

		// Create services
		const [instantiationService, environmentMainService, configurationService, bufferLogService, productService] = this.createServices(args);

		try {

			// Init services
			try {
				await this.initServices(environmentMainService, configurationService);
			} catch (error) {

				// Show a dialog for errors that can be resolved by the user
				this.handleStartupDataDirError(environmentMainService, bufferLogService, productService.nameLong, error);

				throw error;
			}

			// Startup
			await instantiationService.invokeFunction(async accessor => {
				const logService = accessor.get(ILogService);

				const mainProcessNodeIpcServer = await this.claimInstance(logService, environmentMainService);

				// Delay creation of spdlog for perf reasons (https://github.com/microsoft/vscode/issues/72906)
				// bufferLogService.logger = new SpdLogLogger('main', join(environmentService.logsPath, 'main.log'), true, bufferLogService.getLevel());
				//bufferLogService.logger = new ConsoleLogger();

				// Lifecycle
				/*once(lifecycleMainService.onWillShutdown)(() => {
					fileService.dispose();
					configurationService.dispose();
				});*/


				return instantiationService.createInstance(CheApplication, mainProcessNodeIpcServer).startup();
			});
		} catch (error) {
			instantiationService.invokeFunction(this.quit, error);
		}
		return instantiationService;
	}

	private handleStartupDataDirError(environmentMainService: INativeEnvironmentService, bufferLogService: BufferLogService, title: string, error: NodeJS.ErrnoException): void {
		if (error.code === 'EACCES' || error.code === 'EPERM') {
			const directories = coalesce([environmentMainService.userDataPath, environmentMainService.extensionsPath, XDG_RUNTIME_DIR]).map(folder => getPathLabel(folder, environmentMainService));


			bufferLogService.error(
				localize('startupDataDirError', "Unable to write program user data."),
				localize('startupUserDataAndExtensionsDirErrorDetail', "{0}\n\nPlease make sure the following directories are writeable:\n\n{1}", toErrorMessage(error), directories.join('\n')),
				title
			);
		}
	}

	private async claimInstance(logService: ILogService, environmentMainService: INativeEnvironmentService): Promise<IPCServer<RemoteAgentConnectionContext>> {


		const mainProcessNodeIpcServer = new IPCServer<RemoteAgentConnectionContext>(this.onDidClientConnectEmitter.event);

		// Print --status usage info
		if (environmentMainService.args.status) {
			logService.warn('Warning: The --status argument can only be used if Code is already running. Please run it again after Code has started.');

			throw new ExpectedError('Terminating...');
		}

		// Set the VSCODE_PID variable here when we are sure we are the first
		// instance to startup. Otherwise we would wrongly overwrite the PID
		process.env['VSCODE_PID'] = String(process.pid);

		return mainProcessNodeIpcServer;
	}


	private quit(accessor: ServicesAccessor, reason?: ExpectedError | Error): void {
		const logService = accessor.get(ILogService);

		if (reason) {
			if ((reason as ExpectedError).isExpected) {
				if (reason.message) {
					logService.trace(reason.message);
				}
			} else {
				if (reason.stack) {
					logService.error(reason.stack);
				} else {
					logService.error(`Startup error: ${reason.toString()}`);
				}
			}
		}
	}

	protected createServices(args: NativeParsedArgs): [IInstantiationService, INativeEnvironmentService, ConfigurationService, BufferLogService, IProductService] {
		const services = new ServiceCollection();

		// Product
		const productService = { _serviceBrand: undefined, ...product };
		services.set(IProductService, productService);

		// Environment
		const environmentMainService = new NativeEnvironmentService(args, productService);
		services.set(INativeEnvironmentService, environmentMainService);
		services.set(IEnvironmentService, environmentMainService);

		// Log: We need to buffer the spdlog logs until we are sure
		// we are the only instance running, otherwise we'll have concurrent
		// log file access on Windows (https://github.com/microsoft/vscode/issues/41218)
		const bufferLogService = new BufferLogService();
		const logService = new MultiplexLogService([new ConsoleMainLogger(getLogLevel(environmentMainService)), bufferLogService]);
		process.once('exit', () => logService.dispose());
		services.set(ILogService, logService);


		// Files
		const fileService = new FileService(logService);
		services.set(IFileService, fileService);
		const diskFileSystemProvider = new DiskFileSystemProvider(logService);
		services.set(InjectedDiskFileSystemProviderDecorator, diskFileSystemProvider);
		fileService.registerProvider(Schemas.file, diskFileSystemProvider);

		// Logger
		services.set(ILoggerService, new LoggerService(logService, fileService));

		// Configuration
		const configurationService = new ConfigurationService(environmentMainService.settingsResource, fileService);
		services.set(IConfigurationService, configurationService);

		// copy from extensionHostProcessSetup.ts
		const uriTransformerPath = path.join(__dirname, './che-uri-transformer');

		// Che specific stuff to serve http requests
		services.set(HttpRequestHandler, new SyncDescriptor(CheHttpRequestHandler));
		services.set(WebsocketHandler, new SyncDescriptor(CheWebsocketHandler, [this.onDidClientConnectEmitter, uriTransformerPath]));
		services.set(HttpServer, new SyncDescriptor(CheHttpServer, [8080]));

		// instantiate services
		const instantiationService = new InstantiationService(services);
		return [instantiationService, environmentMainService, configurationService, bufferLogService, productService];
	}

	private async initServices(environmentMainService: INativeEnvironmentService, configurationService: ConfigurationService) {

		// Init folders
		// Do as in electron-main#initServices:
		// Environment service (paths)
		await Promise.all<string | undefined>([
			environmentMainService.extensionsPath,
			environmentMainService.logsPath,
			environmentMainService.globalStorageHome.fsPath,
			environmentMainService.workspaceStorageHome.fsPath,
		].map(path => path ? Promises.mkdir(path, { recursive: true }) : undefined));

		// Configuration service
		await configurationService.initialize();
	}

	private resolveArgs(): NativeParsedArgs {

		// Parse arguments
		const args = this.validatePaths(parseMainProcessArgv(process.argv));

		// If we are started with --wait create a random temporary file
		// and pass it over to the starting instance. We can use this file
		// to wait for it to be deleted to monitor that the edited file
		// is closed and then exit the waiting process.
		//
		// Note: we are not doing this if the wait marker has been already
		// added as argument. This can happen if Code was started from CLI.
		if (args.wait && !args.waitMarkerFilePath) {
			const waitMarkerFilePath = createWaitMarkerFile(args.verbose);
			if (waitMarkerFilePath) {
				addArg(process.argv, '--waitMarkerFilePath', waitMarkerFilePath);
				args.waitMarkerFilePath = waitMarkerFilePath;
			}
		}

		return args;
	}

	private validatePaths(args: NativeParsedArgs): NativeParsedArgs {

		// Track URLs if they're going to be used
		if (args['open-url']) {
			args._urls = args._;
			args._ = [];
		}

		// Normalize paths and watch out for goto line mode
		if (!args['remote']) {
			const paths = this.doValidatePaths(args._, args.goto);
			args._ = paths;
		}

		return args;
	}

	private doValidatePaths(args: string[], gotoLineMode?: boolean): string[] {
		const cwd = process.env['VSCODE_CWD'] || process.cwd();
		const result = args.map(arg => {
			let pathCandidate = String(arg);

			let parsedPath: IPathWithLineAndColumn | undefined = undefined;
			if (gotoLineMode) {
				parsedPath = parseLineAndColumnAware(pathCandidate);
				pathCandidate = parsedPath.path;
			}

			if (pathCandidate) {
				pathCandidate = this.preparePath(cwd, pathCandidate);
			}

			const sanitizedFilePath = sanitizeFilePath(pathCandidate, cwd);

			const filePathBasename = basename(sanitizedFilePath);
			if (filePathBasename /* can be empty if code is opened on root */ && !isValidBasename(filePathBasename)) {
				return null; // do not allow invalid file names
			}

			if (gotoLineMode && parsedPath) {
				parsedPath.path = sanitizedFilePath;

				return this.toPath(parsedPath);
			}

			return sanitizedFilePath;
		});

		const caseInsensitive = isWindows || isMacintosh;
		const distinctPaths = distinct(result, path => path && caseInsensitive ? path.toLowerCase() : (path || ''));

		return coalesce(distinctPaths);
	}

	private preparePath(cwd: string, path: string): string {

		// Trim trailing quotes
		if (isWindows) {
			path = rtrim(path, '"'); // https://github.com/microsoft/vscode/issues/1498
		}

		// Trim whitespaces
		path = trim(trim(path, ' '), '\t');

		if (isWindows) {

			// Resolve the path against cwd if it is relative
			path = resolve(cwd, path);

			// Trim trailing '.' chars on Windows to prevent invalid file names
			path = rtrim(path, '.');
		}

		return path;
	}

	private toPath(pathWithLineAndCol: IPathWithLineAndColumn): string {
		const segments = [pathWithLineAndCol.path];

		if (typeof pathWithLineAndCol.line === 'number') {
			segments.push(String(pathWithLineAndCol.line));
		}

		if (typeof pathWithLineAndCol.column === 'number') {
			segments.push(String(pathWithLineAndCol.column));
		}

		return segments.join(':');
	}

}

