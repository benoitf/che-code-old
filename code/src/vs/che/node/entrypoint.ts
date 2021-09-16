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

import { Main } from './main';

/**
 * Entrypoint that starts the main method asynchronously
 */
export async function startCheCode(): Promise<void> {
	const main = new Main();
	const success = await main.start();
	if (!success) {
		process.exit(1);
	}
}

startCheCode().catch((err) => console.log(err));
