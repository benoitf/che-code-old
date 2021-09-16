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

import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { Emitter, Event } from 'vs/base/common/event';
import { ILogService } from 'vs/platform/log/common/log';
import { URI } from 'vs/base/common/uri';
import { VSBuffer } from 'vs/base/common/buffer';
import { IStreamListener, listenStream, ReadableStreamEventPayload, ReadableStreamEvents } from 'vs/base/common/stream';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { IRawURITransformer, URITransformer } from 'vs/base/common/uriIpc';
import { IFileChangeDto } from 'vs/workbench/api/common/extHost.protocol';
import { Disposable } from 'vscode';


export const InjectedDiskFileSystemProviderDecorator = createDecorator<DiskFileSystemProvider>('diskFileSystemProvider');


/**
 * Handle the channel for the remote filesystem
 * @see RemoteFileSystemProvider
 * @see BrowserMain
 */
export class RemoteFileSystemChannel implements IServerChannel<RemoteAgentConnectionContext> {

	private readonly fileWatchers = new Map<string, DiskFileSystemProvider>();
	private readonly fileWatcherDisposables = new Map<string, Disposable>();

	constructor(private diskFileSystemProvider: DiskFileSystemProvider, private logService: ILogService,
		private readonly rawURITransformerFactory: (remoteAuthority: string) => IRawURITransformer,
	) {
	}


	async call<T>(ctx: RemoteAgentConnectionContext, command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {

		const rawURITransformer = this.rawURITransformerFactory(ctx.remoteAuthority);
		const uriTranformer = new URITransformer(rawURITransformer);
		// FIXME: need to implement other methods of DiskFileSystemProvider
		switch (command) {
			case 'stat':
				return this.diskFileSystemProvider.stat(URI.revive(uriTranformer.transformIncoming(arg[0])));
			case 'readdir':
				return this.diskFileSystemProvider.readdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
			case 'mkdir':
				return this.diskFileSystemProvider.mkdir(URI.revive(uriTranformer.transformIncoming(arg[0])));
			case 'rename':
				return this.diskFileSystemProvider.rename(URI.revive(uriTranformer.transformIncoming(arg[0])), URI.revive(uriTranformer.transformIncoming(arg[1])), arg[2]);
			case 'readFile':
				const readFileContent = await this.diskFileSystemProvider.readFile(URI.revive(uriTranformer.transformIncoming(arg[0])));
				return this.wrapData(readFileContent);
			case 'open':
				return this.diskFileSystemProvider.open(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
			case 'close':
				return this.diskFileSystemProvider.close(arg[0]);
			case 'read':
				const readBuffer = VSBuffer.alloc(arg[2]);
				const readOffset = 0;
				const readValue = await this.diskFileSystemProvider.read(arg[0], arg[1], readBuffer.buffer, readOffset, arg[2]);
				return [readBuffer, readValue];
			case 'write':
				return this.diskFileSystemProvider.write(arg[0], arg[1], (<VSBuffer>arg[2]).buffer, arg[3], arg[4]);
			case 'writeFile':
				return this.diskFileSystemProvider.writeFile(URI.revive(uriTranformer.transformIncoming(arg[0])), (<VSBuffer>arg[1]).buffer, arg[2]);
			case 'delete':
				return this.diskFileSystemProvider.delete(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1]);
			case 'copy':
				return this.diskFileSystemProvider.copy(URI.revive(uriTranformer.transformIncoming(arg[0])), URI.revive(uriTranformer.transformIncoming(arg[1])), arg[2]);
			case 'watch':
				// example of call

				// [
				// '6e75064c-2759-4aae-abc4-8ba2a778fdf4',
				// 0.44398405189639245,
				// {
				// 	'$mid': 1,
				// 	fsPath: 'eclipse/che-dashboard',
				// 	external: 'vscode-remote://localhost:8080/eclipse/che-dashboard',
				// 	path: '/eclipse/che-dashboard',
				// 	scheme: 'vscode-remote',
				// 	authority: 'localhost:8080'
				// },
				// {
				// 	recursive: true,
				// 	excludes: [
				// 		'**/.git/objects/**',
				// 		'**/.git/subtree-cache/**',
				// 		'**/node_modules/*/**',
				// 		'**/.hg/store/**'
				// 	]
				// }
				const watchKey = `${arg[0]}${arg[1]}`;
				const resource = URI.revive(uriTranformer.transformIncoming(arg[2]));
				const fileWatcher = this.fileWatchers.get(watchKey);
				// found one, call watch on it
				if (fileWatcher) {
					const watchDisposable = fileWatcher.watch(resource, arg[3]);
					this.fileWatcherDisposables.set(watchKey, watchDisposable);
				}
				return;
			case 'unwatch':
				const unwatchKey = `${arg[0]}${arg[1]}`;
				const toUnwatchDisposable = this.fileWatcherDisposables.get(unwatchKey);
				// if there, dispose it and remote the key
				if (toUnwatchDisposable) {
					this.fileWatcherDisposables.delete(unwatchKey);
					toUnwatchDisposable.dispose();
				}
				return;
		}
		const msg = `RemoteFileSystemChannel: unsupported command/${command}`;
		this.logService.error(msg);
		throw new Error(msg);
	}

	listen<T>(ctx: RemoteAgentConnectionContext, event: string, arg?: any): Event<any> {
		const rawURITransformer = this.rawURITransformerFactory(ctx.remoteAuthority);
		const uriTranformer = new URITransformer(rawURITransformer);

		switch (event) {
			case 'readFileStream':
				const cancellationTokenSource = new CancellationTokenSource();
				const cancellationToken = cancellationTokenSource.token;
				//  @see IPCFileSystemProvider#readFileStream
				const readableStreamEvents: ReadableStreamEvents<Uint8Array> = this.diskFileSystemProvider.readFileStream(URI.revive(uriTranformer.transformIncoming(arg[0])), arg[1], cancellationToken);
				const readFileSteamEmitter = new Emitter<ReadableStreamEventPayload<VSBuffer>>({
					onLastListenerRemove: () => cancellationTokenSource.cancel()
				});
				const listener: IStreamListener<Uint8Array> = {
					onData: (data: Uint8Array) => readFileSteamEmitter.fire(this.wrapData(data)),
					onError: (error: Error) => readFileSteamEmitter.fire(error),
					onEnd: () => { readFileSteamEmitter.fire('end'), readFileSteamEmitter.dispose(), cancellationTokenSource.dispose(); }
				};
				listenStream(readableStreamEvents, listener);
				return readFileSteamEmitter.event;
			// client is doing:
			// this._register(this.channel.listen<IFileChangeDto[] | string>('filechange', [this.session])(eventsOrError => {
			case 'filechange':
				// Grab event
				const fileChangeEmitter = new Emitter<IFileChangeDto>({
					// perform cleanup on last listener remove
					onLastListenerRemove: () => { this.fileWatchers.get(arg[0])?.dispose(); this.fileWatchers.delete(arg[0]); },
					// initialize the watcher
					onFirstListenerAdd: () => this.fileWatchers.set(arg[0], new DiskFileSystemProvider(this.logService)),
				});
				return fileChangeEmitter.event;
		}
		const msg = `RemoteFileSystemChannel: unsupported event/${event} and arg ${arg}`;
		this.logService.error(msg);
		throw new Error(msg);
	}

	/**
	 * Provides a VSBuffer object
	 */
	wrapData(data: Uint8Array): VSBuffer {
		return VSBuffer.wrap(data);
	}

}
