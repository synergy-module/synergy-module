import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { createAssetManifest } from "../../src/runtime/asset-manifest.js";
import { createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

test("changing a nested module versions the entire asset graph", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "synergy-module-assets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "js"));
  writeFileSync(path.join(directory, "js", "app.js"), 'import "./tool.js";');
  writeFileSync(path.join(directory, "js", "tool.js"), "export const version=1;");
  const first = createAssetManifest(directory);
  assert.equal(createAssetManifest(directory).version, first.version);
  writeFileSync(path.join(directory, "js", "tool.js"), "export const version=2;");
  const second = createAssetManifest(directory);
  assert.notEqual(second.version, first.version);
  assert.notEqual(second.assetPath("/js/app.js"), first.assetPath("/js/app.js"));
});

test("Brain HTML and every relative module or CSS import use the same versioned directory", async () => {
  const app = createTestApp();
  const agent = await loginTestOperator(app);
  const page = await agent.get("/brain").expect(200);
  const scriptPath = page.text.match(/src="(\/assets\/[a-f0-9]+\/js\/app-shell\.js)"/)?.[1];
  assert.ok(scriptPath);
  const script = await request(app).get(scriptPath).expect(200);
  const brainImport = script.text.match(/from "(.+brain-controller\.js)"/)?.[1];
  assert.ok(brainImport);
  const brainPath = new URL(brainImport, `https://test.invalid${scriptPath}`).pathname;
  assert.equal(brainPath.split("/")[2], scriptPath.split("/")[2]);
  await request(app).get(brainPath).expect(200).expect(/initializeRobinhood/);
  const stylePath = page.text.match(/href="(\/assets\/[a-f0-9]+\/css\/brain\.css)"/)?.[1];
  const css = await request(app).get(stylePath).expect(200);
  assert.match(css.text, /robinhood\.css/);
  await request(app).get(new URL("./robinhood.css", `https://test.invalid${stylePath}`).pathname).expect(200).expect(/rh-workspace/);
  await request(app).get("/js/brain/brain-controller.js").expect(200).expect("Cache-Control", "no-cache");
});
