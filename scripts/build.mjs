// Compile src/*.ts to dist/*.js with Node's own type stripper (no dependencies).
// Node does not strip types inside node_modules, so the npm package ships JS.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  const js = stripTypeScriptTypes(readFileSync(`src/${f}`, "utf8")).replace(/(["'])(\.\.?\/[^"']+)\.ts\1/g, "$1$2.js$1");
  writeFileSync(`dist/${f.replace(/\.ts$/, ".js")}`, js);
}
console.log("built", readdirSync("dist").join(", "));
