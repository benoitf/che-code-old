#!/bin/sh
#
# Copyright (c) 2021 Red Hat, Inc.
# This program and the accompanying materials are made
# available under the terms of the Eclipse Public License 2.0
# which is available at https://www.eclipse.org/legal/epl-2.0/
#
# SPDX-License-Identifier: EPL-2.0
#
# Contributors:
#   Red Hat, Inc. - initial API and implementation
#

# list checode-mount
ls -la /checode-mount/

# Start the machine-exec component in background
nohup /checode-mount/bin/machine-exec --url '0.0.0.0:3333' &
sleep 5

# Start the checode component
/checode-mount/bin/node-alpine /checode-mount/out/vs/che/node/entrypoint-loader.js

