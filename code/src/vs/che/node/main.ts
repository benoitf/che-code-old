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

import { CheInstantiationServiceSetup } from 'vs/che/node/che-instantiation-service-setup';
import { HttpServer } from 'vs/che/node/http-server';

/**
 * Starts the main process by initializing the dependency injection mechanism and then invoking the start of the http server
 */
export class Main {

	protected async doStart(): Promise<void> {
		const instantionServiceSetup = new CheInstantiationServiceSetup();
		const instantiationService = await instantionServiceSetup.startup();
		// starts the http server
		instantiationService.invokeFunction(async (accessor) => {
			const httpServer = accessor.get(HttpServer);
			await httpServer.start();
		});
	}

	// Perform the start
	async start(): Promise<boolean> {
		try {
			await this.doStart();
			return true;
		} catch (error) {
			console.error('stack=' + error.stack);
			console.error('Unable to start', error);
			return false;
		}
	}
}

