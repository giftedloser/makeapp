import { describe, test } from "node:test";
import { strict as assert } from "assert";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { scaffoldProject } from "../src/generator.js";

function createNpmStub() {
  const dir = mkdtempSync(join(tmpdir(), "npm-stub-"));
  const stub = join(dir, "npm");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);
  return { dir, stub };
}

describe("dev script", () => {
  test("adds dev script and dev deps", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "scaffold-test-"));
    const { dir: npmDir } = createNpmStub();
    const originalPath = process.env.PATH;
    process.env.PATH = `${npmDir}:${originalPath}`;
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const answers = {
        appName: "dev-app",
        title: "Test",
        description: "",
        author: "",
        license: "MIT",
        scripts: ["dev"],
        features: [],
      };
      const { outDir } = await scaffoldProject(answers);
      const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
      const runAsRoot = typeof process.getuid === "function" && process.getuid() === 0;
      const entry = "electron-main.mjs";
      const electronCmd = runAsRoot
        ? `electron --no-sandbox ${entry}`
        : `electron ${entry}`;
      const expected =
        `cross-env NODE_ENV=development concurrently "tsc -w" "vite --config vite.config.js" "${electronCmd}"`;
      assert.equal(pkg.scripts.dev, expected);
      assert.ok(pkg.devDependencies.typescript);
    } finally {
      process.chdir(cwd);
      process.env.PATH = originalPath;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(npmDir, { recursive: true, force: true });
    }
  });

  test("build script adds ts dev deps", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "scaffold-test-"));
    const { dir: npmDir } = createNpmStub();
    const originalPath = process.env.PATH;
    process.env.PATH = `${npmDir}:${originalPath}`;
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const answers = {
        appName: "build-app",
        title: "Test",
        description: "",
        author: "",
        license: "MIT",
        scripts: ["build"],
        features: [],
      };
      const { outDir } = await scaffoldProject(answers);
      const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
      assert.ok(pkg.devDependencies.typescript);
      assert.ok(pkg.devDependencies["@types/node"]);
    } finally {
      process.chdir(cwd);
      process.env.PATH = originalPath;
      rmSync(tmp, { recursive: true, force: true });
      rmSync(npmDir, { recursive: true, force: true });
    }
  });
});
