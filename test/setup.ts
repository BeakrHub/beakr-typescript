/**
 * Every test runs with an empty Beakr home, so a client built without an
 * explicit credential never picks up the developer's real CLI sign-in
 * (`~/.beakr/credentials`) or saved key. Tests that exercise the stored
 * sign-in point BEAKR_HOME at their own temporary directory.
 *
 * No test runs the real `beakr` executable either (it would read the real OS
 * keychain): the CLI is "not installed" unless a test installs its own runner
 * (test/cli-token.test.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach } from "vitest";

import { setCliRunner } from "../src/cli-token.js";

process.env.BEAKR_HOME = mkdtempSync(join(tmpdir(), "beakr-home-empty-"));

beforeEach(() => {
  setCliRunner(async () => ({ exitCode: null, stdout: "", stderr: "", notFound: true }));
});
