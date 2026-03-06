// @ts-check
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  outfile: "./dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !isProduction,
  minify: isProduction,
  tsconfig: "./tsconfig.json",
};

/** @type {esbuild.BuildOptions} */
const gitGraphWebviewConfig = {
  entryPoints: ["./webview-ui/gitGraph/index.ts"],
  bundle: true,
  outfile: "./dist/webview-ui/gitGraph.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !isProduction,
  minify: isProduction,
  tsconfig: "./tsconfig.webview.json",
};

/** @type {esbuild.BuildOptions} */
const commitChangesWebviewConfig = {
  entryPoints: ["./webview-ui/commitChanges/index.ts"],
  bundle: true,
  outfile: "./dist/webview-ui/commitChanges.js",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: !isProduction,
  minify: isProduction,
  tsconfig: "./tsconfig.webview.json",
};

/**
 * Copy webview CSS files into dist so they are available in the packaged extension.
 */
function copyWebviewCss() {
  const pairs = [
    ["webview-ui/gitGraph/styles.css", "dist/webview-ui/gitGraph.css"],
    [
      "webview-ui/commitChanges/styles.css",
      "dist/webview-ui/commitChanges.css",
    ],
  ];
  for (const [src, dest] of pairs) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

async function main() {
  copyWebviewCss();
  const configs = [
    extensionConfig,
    gitGraphWebviewConfig,
    commitChangesWebviewConfig,
  ];

  if (isWatch) {
    const contexts = await Promise.all(
      configs.map((config) => esbuild.context(config)),
    );
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[esbuild] Watching for changes...");
  } else {
    await Promise.all(configs.map((config) => esbuild.build(config)));
    console.log("[esbuild] Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
