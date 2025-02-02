/**
 * @license
 * Copyright 2022 The node-matter Authors
 * SPDX-License-Identifier: Apache-2.0
 */

// Needs to be first import!
import { MinimalOnOffDeviceTestInstance } from "../MinimalOnOffDeviceTestInstance";

import { StorageBackendMemory } from "@project-chip/matter.js/storage";

/** Test case "TestOperationalCredentialsCluster" */
export class TestOperationalCredentialsCluster extends MinimalOnOffDeviceTestInstance {
    constructor(storage: StorageBackendMemory) {
        super("TestOperationalCredentialsCluster", "GeneralTestPicsFile.txt", storage);
    }
}
