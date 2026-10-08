import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createDiscordAuthConfig, createTestApp, loginTestOperator } from "../helpers/auth-test-helpers.js";

test("unknown full requests return the terminal 404 page", async () => {
  const agent = await loginTestOperator(createTestApp());
  const response = await agent.get("/missing-terminal-route").expect(404);
  assert.match(response.text, /<!doctype html>/i);
  assert.match(response.text, /404 :: ROUTE NOT FOUND/);
  assert.match(response.text, /data-error-page/);
});

test("unknown fragment requests return only a safe 404 fragment", async () => {
  const agent = await loginTestOperator(createTestApp());
  const response = await agent.get("/missing-terminal-route").set("X-Synergy-Module-Fragment", "1").expect(404);
  assert.match(response.text, /404 :: ROUTE NOT FOUND/);
  assert.doesNotMatch(response.text, /<!doctype html>|data-app-shell/i);
});

test("production server errors omit stack traces", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const diagnostics = [];
    const app = createApp({
      sessionSecret: "test-secret",
      authConfig: createDiscordAuthConfig(),
      sessionStore: new (await import("express-session")).default.MemoryStore(),
      configureRoutes(instance) { instance.get("/explode", () => { throw new Error("sensitive database detail"); }); },
      logger: { error: (...values) => diagnostics.push(values) },
    });
    const response = await request(app).get("/explode").expect(500);
    assert.match(response.text, /500 :: INTERNAL TERMINAL ERROR/);
    assert.doesNotMatch(response.text, /sensitive database detail|Error:|at createApp/);
    assert.deepEqual(diagnostics, [["Unhandled application error"]]);
    assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive database detail|Error:|at createApp/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("headers-sent server errors are delegated to the next error handler", () => {
  const diagnostics = [];
  const app = createTestApp({
    sessionSecret: "test-secret",
    logger: { error: (...values) => diagnostics.push(values) },
  });
  const errorHandler = app.router.stack.map((layer) => layer.handle).findLast((handle) => handle.length === 4);
  const expected = new Error("stream failed after response started");
  const delegated = [];

  errorHandler(expected, {}, { headersSent: true }, (error) => delegated.push(error));

  assert.deepEqual(delegated, [expected]);
  assert.deepEqual(diagnostics, [["Unhandled application error"]]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /stream failed|Error:|stack/i);
});
