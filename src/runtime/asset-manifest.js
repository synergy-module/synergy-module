import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Version the entire public tree so relative CSS and module imports share the deployment version. */
export function createAssetManifest(directory) {
  const hash = createHash("sha256");
  function visit(relative = "") {
    const entries = readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) hash.update(name).update("\0").update(readFileSync(path.join(directory, name))).update("\0");
    }
  }
  visit();
  const version = hash.digest("hex").slice(0, 20);
  return { version, assetPath: (name) => `/assets/${version}/${name.replace(/^\/+/, "")}` };
}
