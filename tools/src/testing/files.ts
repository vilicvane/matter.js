/**
 * @license
 * Copyright 2022-2023 Project CHIP Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from "fs";
import { Package } from "../util/package.js";

export function listSupportFiles(format = "cjs") {
    const files = Array<string>();

    // Always load tooling code in ESM format as tooling globals load as ESM
    files.push(Package.tools.resolve("dist/esm/testing/global-definitions.js"));
    files.push(Package.tools.resolve("dist/esm/testing/mocks/index.js"));

    // Package code should load in the format being tested
    const config = Package.project.resolve(`build/${format}/test/test.config.js`);
    if (existsSync(config)) {
        files.push(config);
    }

    return files;
}
