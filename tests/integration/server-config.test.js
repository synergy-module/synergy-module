import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function testServerEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DISCORD_") || key.startsWith("DATABASE_") || key.startsWith("BRAIN_")
      || key.startsWith("TRADER_") || key.endsWith("_API_KEY")) delete env[key];
  }
  return {
    ...env, NODE_ENV: "test", APP_ENVIRONMENT: "test", AUTH_MODE: "discord",
    SESSION_SECRET: "test-server-secret", BRAIN_DB_PATH: ":memory:", TRADER_PAID_AI_ENABLED: "false",
    DISCORD_CLIENT_ID: "test-client", DISCORD_CLIENT_SECRET: "test-client-secret",
    DISCORD_REDIRECT_URI: "http://127.0.0.1:3000/auth/discord/callback", DISCORD_GUILD_ID: "test-guild",
    DISCORD_ROLE_DEVELOPER_ID: "test-developer", DISCORD_ROLE_ADMIN_ID: "test-admin",
    DISCORD_ROLE_OS_ID: "test-os", DISCORD_ROLE_INDICATORS_ID: "test-indicators",
    DISCORD_ROLE_JOURNAL_ID: "test-journal", ...overrides,
  };
}

function reservePort(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`server startup timeout: ${output}`)), 5000);
    const onData = (chunk) => {
      output += chunk;
      if (pattern.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited ${code}: ${output}`));
    });
  });
}

test("server honors HOST and logs the full listening address", async () => {
  const host = "127.0.0.2";
  const port = await reservePort(host);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("../..", import.meta.url),
    env: testServerEnvironment({ HOST: host, PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const output = await waitForOutput(child, /Synergy Module listening/);
    assert.match(output, new RegExp(`http://${host}:${port}`));
    const response = await fetch(`http://${host}:${port}/login`);
    assert.equal(response.status, 200);
    const markup = await response.text();
    assert.match(markup, /SIGN IN WITH DISCORD/);
    assert.doesNotMatch(markup, /data-login-form|data-login-passkey|action="\/auth\/login"/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/login`));
  } finally {
    child.kill();
  }
});

test("production server reports unavailable PostgreSQL through readiness", async () => {
  const host = "127.0.0.1";
  const port = await reservePort(host);
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: new URL("../..", import.meta.url),
    env: testServerEnvironment({
      NODE_ENV: "production", APP_ENVIRONMENT: "production", HOST: host, PORT: String(port),
      DISCORD_REDIRECT_URI: "https://synergymodule.app/auth/discord/callback",
      DATABASE_URL: "postgres://operator:test-password@127.0.0.1:1/synergy-module",
      DATABASE_SSL: "disable", DATABASE_CONNECT_TIMEOUT_MS: "100",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    await waitForOutput(child, /Synergy Module listening/);
    const response = await fetch(`http://${host}:${port}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "unavailable" });
  } finally {
    child.kill();
  }
});

test("server exits before listening when Discord configuration is missing or demo is requested", async () => {
  for (const [overrides, expected] of [
    [{ AUTH_MODE: "", DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "" }, /Missing required Discord configuration: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET/],
    [{ AUTH_MODE: "demo" }, /Discord authentication is required; AUTH_MODE must be discord/],
  ]) {
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: new URL("../..", import.meta.url),
      env: testServerEnvironment({ HOST: "127.0.0.1", PORT: "0", ...overrides }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      await assert.rejects(waitForOutput(child, /Synergy Module listening/), (error) => {
        assert.match(error.message, /server exited 1/);
        assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /Synergy Module listening|test-client-secret/);
        return true;
      });
    } finally {
      child.kill();
    }
  }
});

if (process.platform === "win32") {
  test("Windows launcher reports safe configuration and invokes npm start", async () => {
    const fakeBin = await mkdtemp(path.join(os.tmpdir(), "synergy-module-launcher-"));
    const nodeShim = path.join(fakeBin, "node.cmd");
    const npmShim = path.join(fakeBin, "npm.cmd");
    await writeFile(nodeShim, "@exit /b 0\r\n", "utf8");
    await writeFile(npmShim, [
      "@echo [TEST npm] %*",
      "@echo [TEST config] HOST=%HOST% PORT=%PORT%",
      "@exit /b 0",
      "",
    ].join("\r\n"), "utf8");

    const launcher = fileURLToPath(new URL("../../start-synergy-module.bat", import.meta.url));
    const childEnv = {
      ...process.env,
      PATH: `${fakeBin};${process.env.PATH}`,
      SYNERGY_MODULE_SKIP_BROWSER: "1",
    };
    delete childEnv.HOST;
    delete childEnv.PORT;
    const child = spawn("cmd.exe", ["/d", "/c", "start-synergy-module.bat"], {
      cwd: path.dirname(launcher),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    try {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const exitCode = await new Promise((resolve) => child.once("exit", resolve));

      assert.equal(exitCode, 0, output);
      assert.match(output, /\[Synergy Module\] Starting the MVC app/);
      assert.match(output, /Authentication configuration: npm start loads \.env when present/);
      assert.match(output, /Browser launch skipped/);
      assert.match(output, /\[TEST npm\] start/);
      assert.match(output, /\[TEST config\] HOST= PORT=/);
      assert.doesNotMatch(output, /SESSION_SECRET|DISCORD_CLIENT_SECRET/);
    } finally {
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
}
