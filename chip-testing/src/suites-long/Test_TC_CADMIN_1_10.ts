/**
 * @license
 * Copyright 2022 The node-matter Authors
 * SPDX-License-Identifier: Apache-2.0
 */

// Needs to be first import!
import { MinimalOnOffDeviceTestInstance } from "../MinimalOnOffDeviceTestInstance";

import { StorageBackendMemory } from "@project-chip/matter.js/storage";

/** Test case "Test_TC_CADMIN_1_10" */
export class Test_TC_CADMIN_1_10 extends MinimalOnOffDeviceTestInstance {
    constructor(storage: StorageBackendMemory, overrideTestName?: string) {
        super(overrideTestName ?? "Test_TC_CADMIN_1_10", "GeneralTestPicsFile.txt", storage);
    }
}
