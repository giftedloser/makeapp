// File: src/generator.js
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { fullScriptMap } from "./config/scripts.js";
import { copyDirRecursive, ensureDir } from "./utils/fileOps.js";
import { renderTemplateFiles } from "./utils/render.js";
import { info, warn, error } from "./utils/logger.js";
import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function scaffoldProject(answers, options = {}) {
  const { skipInstall = false } = options;
  const outDir = path.resolve(process.cwd(), answers.appName);

  // helper to remove the project directory on failure
  const cleanupProject = async () => {
    try {
      await fs.rm(outDir, { recursive: true, force: true });
    } catch (err) {
      warn(`Failed to clean up '${outDir}': ${err.message}`);
    }
  };

  // Prevent overwriting non-empty existing folder
  try {
    await ensureDir(outDir);
  } catch (e) {
    throw new Error(`Failed to ensure project directory: ${e.message}`);
  }

  const filesInDir = await fs.readdir(outDir);
  if (filesInDir.length > 0) {
    throw new Error(`Target directory '${outDir}' exists and is not empty.`);
  }

  // Ensure preload feature when required by other features
  if (
    (answers.features.includes("darkmode") || answers.features.includes("frameless")) &&
    !answers.features.includes("preload")
  ) {
    answers.features.push("preload");
    answers.autoPreload = true;
    info("Preload feature enabled automatically.");
  }

  // Define required dependencies explicitly
  const dependencies = {
    react: "^18.0.0",
    "react-dom": "^18.0.0",
    electron: "^29.0.0"
  };

  const devDependencies = {
    vite: "^4.5.14",
    "@vitejs/plugin-react": "^3.0.0",
    typescript: "^5.4.5",
    "@types/node": "^20.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0"
  };

  const featurePackages = {
    sqlite: { dependencies: { "better-sqlite3": "^12.2.0" } },
    prettier: { devDependencies: { prettier: "^3.6.2" } },
    eslint: {
      devDependencies: {
        eslint: "^8.56.0",
        "@typescript-eslint/parser": "^6.7.0",
        "@typescript-eslint/eslint-plugin": "^6.7.0",
      },
    },
    sso: { dependencies: { "node-fetch": "^3.3.2" } },
  };

  // Build package.json with selected scripts and dependencies
  const pkg = {
    name: answers.appName,
    version: "0.1.0",
    description: answers.description,
    author: answers.author,
    license: answers.license,
    type: "module",
    main: "electron-main.mjs",
    scripts: {},
    dependencies: {},
    devDependencies: {},
  };
  for (const key of answers.scripts) {
    if (fullScriptMap[key]) {
      pkg.scripts[key] = fullScriptMap[key];
    }
  }

  pkg.dependencies = { ...dependencies };
  Object.assign(pkg.devDependencies, devDependencies);

  for (const feature of answers.features) {
    const packs = featurePackages[feature];
    if (!packs) continue;
    if (packs.dependencies) {
      Object.assign(pkg.dependencies, packs.dependencies);
    }
    if (packs.devDependencies) {
      Object.assign(pkg.devDependencies, packs.devDependencies);
    }
  }

  // Script-specific dev dependencies
  if (answers.scripts.includes("dist")) {
    pkg.devDependencies["electron-builder"] = "^26.0.0";
  }
  if (answers.scripts.includes("clean") || answers.scripts.includes("reset")) {
    pkg.devDependencies["rimraf"] = "^6.0.1";
  }
  if (answers.scripts.includes("start")) {
    pkg.devDependencies.concurrently = "^8.2.2";
    pkg.devDependencies["wait-on"] = "^7.0.1";
  }
  if (answers.scripts.includes("dev") || answers.scripts.includes("build")) {
    pkg.devDependencies.typescript = "^5.4.5";
    pkg.devDependencies["@types/node"] = "^20.0.0";
  }

  try {
    await fs.writeFile(
      path.join(outDir, "package.json"),
      JSON.stringify(pkg, null, 2),
      "utf8"
    );
  } catch (e) {
    await cleanupProject();
    throw new Error(`Failed to write package.json: ${e.message}`);
  }

  // Copy base template always
  const baseTemplateDir = path.resolve(__dirname, "../templates/base");
  try {
    await copyDirRecursive(baseTemplateDir, outDir);
  } catch (e) {
    await cleanupProject();
    throw new Error(`Failed copying base templates: ${e.message}`);
  }

  // Include preload script only if feature selected
  const preloadFile = path.join(outDir, "src", "preload.ts");
  const mainFile = path.join(outDir, "src", "main.ts");
  const appFile = path.join(outDir, "src", "App.tsx");
  const usingPreload = answers.features.includes("preload") || answers.features.includes("frameless");
  if (!usingPreload) {
    try {
      await fs.rm(preloadFile, { force: true });
    } catch {
      // ignore if file does not exist
    }

    // Remove preload property from BrowserWindow options
    try {
      let mainContent = await fs.readFile(mainFile, "utf8");
      const lines = mainContent.split(/\r?\n/);
      const idx = lines.findIndex((l) => l.includes("preload"));
      if (idx !== -1) {
        lines.splice(idx, 1);
        if (idx - 1 >= 0) {
          lines[idx - 1] = lines[idx - 1].replace(/,\s*$/, "");
        }
      }
      // Remove import path line if unused
      const pathImportIdx = lines.findIndex((l) =>
        /^import\s+path\s+from\s+["']path["']/.test(l)
      );
      if (pathImportIdx !== -1) {
        const stillUsesPath = lines.some(
          (l, i) => i !== pathImportIdx && l.includes("path.")
        );
        if (!stillUsesPath) {
          lines.splice(pathImportIdx, 1);
        }
      }
      await fs.writeFile(mainFile, lines.join("\n"));
    } catch {
      // ignore modification errors
    }

    // Remove window.api effect block from App.tsx
    try {
      let appContent = await fs.readFile(appFile, "utf8");
      appContent = appContent.replace(/\s*useEffect\(\(\) => {[\s\S]*?}\s*,\s*\[\]\);?/m, "");
      await fs.writeFile(appFile, appContent);
    } catch {
      // ignore errors
    }
  }

  // Copy feature templates conditionally
  for (const feature of answers.features) {
    if (feature === "git") {
      // skip features handled separately
      continue;
    }
    const featureTemplateDir = path.resolve(
      __dirname,
      `../templates/with-${feature}`
    );
    try {
      await fs.access(featureTemplateDir);
      await copyDirRecursive(featureTemplateDir, outDir);
    } catch {
      // No template for feature; silently continue
    }
  }



  if (answers.features.includes("sso")) {
    const ssoSrc = path.resolve(__dirname, "../templates/with-sso/auth.js");
    try {
      await fs.copyFile(ssoSrc, path.join(outDir, "auth.js"));
    } catch {
      // ignore copy errors
    }
  }

// Conditionally inject main process imports for selected features
const extraImports = [];


if (answers.features.includes("sso")) {
  extraImports.push("../auth.js");
}

if (extraImports.length > 0) {
  try {
    let mainContent = await fs.readFile(mainFile, "utf8");
    const lines = mainContent.split(/\r?\n/);
    let insertIdx = lines.findIndex((l) => !/^import /.test(l));
    if (insertIdx === -1) insertIdx = lines.length;
    for (const imp of extraImports) {
      lines.splice(insertIdx, 0, `import '${imp}';`);
      insertIdx++;
    }
    await fs.writeFile(mainFile, lines.join("\n"));
  } catch {
    // ignore file modification errors
  }
}


  // Handle darkmode feature separately
  if (answers.features.includes("darkmode")) {
    const darkSrc = path.resolve(
      __dirname,
      "../templates/with-darkmode/src/darkmode.js"
    );
    const darkDestSrc = path.join(outDir, "src", "darkmode.js");
    const darkDestRoot = path.join(outDir, "src", "darkmode.js");
    try {
      await fs.copyFile(darkSrc, darkDestSrc);
    } catch (e) {
      error(`Failed copying darkmode.js to ${darkDestSrc}: ${e.message}`);
      await cleanupProject();
      throw new Error(`Failed copying darkmode.js: ${e.message}`);
    }
    try {
      await fs.copyFile(darkSrc, darkDestRoot);
    } catch (e) {
      error(`Failed copying darkmode.js to ${darkDestRoot}: ${e.message}`);
      await cleanupProject();
      throw new Error(`Failed copying darkmode.js: ${e.message}`);
    }
  }


  // Include electron-builder config if dist script selected
  if (answers.scripts.includes("dist")) {
    const builderTemplate = path.resolve(__dirname, "../templates/with-dist");
    try {
      await fs.access(builderTemplate);
      await copyDirRecursive(builderTemplate, outDir);
    } catch {
      // ignore if template missing
    }
  }

  // Remove global.d.ts when preload feature not selected
  const globalTypesPath = path.join(outDir, "src", "global.d.ts");
  if (!answers.features.includes("preload")) {
    try {
      await fs.rm(globalTypesPath, { force: true });
    } catch {
      // ignore errors
    }
  }

  // Remove global.d.ts from tsconfig if not present
  try {
    await fs.access(globalTypesPath);
  } catch {
    const tsconfigPath = path.join(outDir, "tsconfig.json");
    try {
      const tsconfig = JSON.parse(await fs.readFile(tsconfigPath, "utf8"));
      if (Array.isArray(tsconfig.include)) {
        tsconfig.include = tsconfig.include.filter((p) => p !== "src/global.d.ts");
      }
      await fs.writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2));
    } catch {
      // ignore tsconfig modification errors
    }
  }

  // Inject tokens (appName, title, author, license) into templates
  try {
    const tokens = {
      APP_NAME: answers.appName,
      WINDOW_TITLE: answers.title,
      AUTHOR: answers.author,
      LICENSE: answers.license,
      DESCRIPTION: answers.description,
      FRAMELESS: answers.features.includes("frameless") ? "true" : "false",
      DARKMODE_IMPORT: answers.features.includes("darkmode")
        ? [
            "try {",
            "  await import('./darkmode.js');",
            "} catch {",
            "  console.error('Missing dist/darkmode.js. Ensure allowJs is enabled in tsconfig.json and darkmode.js is placed under src.');",
            "  process.exit(1);",
            "}",
          ].join("\n")
        : "",
    };
    await renderTemplateFiles(outDir, tokens);
  } catch (e) {
    await cleanupProject();
    throw new Error(`Template token rendering failed: ${e.message}`);
  }

  // Install dependencies using chosen package manager
  const pm = answers.packageManager || "npm";
  if (!skipInstall) {
    try {
      info("🔧 Installing dependencies...");
      await execa(pm, ["install"], { cwd: outDir, stdio: "inherit" });
    } catch (e) {
      await cleanupProject();
      throw new Error(`${pm} install failed: ${e.message}. Project directory cleaned up.`);
    }
  } else {
    info("⚠️  Skipping dependency installation (SKIP_INSTALL)");
  }

  // Initialize Git repo if selected
  if (answers.features.includes("git")) {
    try {
      info("🔧 Initializing Git repository...");
      await execa("git", ["init"], { cwd: outDir });
      await execa("git", ["add", "."], { cwd: outDir });
      await execa("git", ["commit", "-m", "Initial commit"], { cwd: outDir });
    } catch (e) {
      // remove .git to avoid half-baked repo
      try {
        await fs.rm(path.join(outDir, ".git"), { recursive: true, force: true });
      } catch {}
      await cleanupProject();
      throw new Error(`Git initialization failed: ${e.message}. Cleaned up project directory.`);
    }
  }

  return {
    outDir,
    metadata: answers,
    packageJson: pkg,
  };
}
