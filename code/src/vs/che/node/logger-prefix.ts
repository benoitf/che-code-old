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

import { ILogService } from 'vs/platform/log/common/log';

export class LoggerWithPrefix {

	constructor(private readonly logService: ILogService, private prefix: string) {

	}


	public info(message: string, ...args: any[]): void {
		this.logService.info(`${this.prefix}: ${message}`, ...args);
	}

	public error(message: string, ...args: any[]): void {
		this.logService.error(`${this.prefix}: ${message}`, ...args);
	}

	public warn(message: string, ...args: any[]): void {
		this.logService.warn(`${this.prefix}: ${message}`, ...args);
	}

}


