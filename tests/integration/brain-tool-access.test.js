import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createTestApp, loginTestOperator, readCsrfToken } from "../helpers/auth-test-helpers.js";
import { createMemoryBrainToolPolicyRepository, createPostgresBrainToolPolicyRepository } from "../../src/agent-brain/brain-tool-policy-repository.js";
import { createBrainToolPolicy } from "../../src/agent-brain/brain-tool-policy.js";
import pg from "pg";
import { readFile } from "node:fs/promises";

test("only admins can inspect tools/sources and save versioned assignments with CSRF", async t => {
  const repository = createMemoryBrainToolPolicyRepository();
  let sourceCalls = 0;
  const source = { status: async()=>({connected:true,counts:{artifact:42}}), search:async()=>{sourceCalls++;return {matches:[]};}, read:async()=>{sourceCalls++;return {excerpt:"fixture"};} };
  const app = createTestApp({ brainToolPolicyRepository:repository,synergyResearch:source });
  const memberApp = createTestApp({ roles:["OS"],brainToolPolicyRepository:repository,synergyResearch:source });
  t.after(async()=>{await app.locals.brainService.close();await memberApp.locals.brainService.close();});
  for(const endpoint of ["/api/brain/tools","/api/brain/synergy/search?query=NQ","/api/brain/synergy/read?kind=artifact&id=fixture"]){
    await request(app).get(endpoint).expect(401);
    await (await loginTestOperator(memberApp)).get(endpoint).expect(403);
  }
  const member = await loginTestOperator(memberApp), admin = await loginTestOperator(app);
  assert.equal((await member.get("/api/brain/state")).body.canManageTools,false);
  assert.equal((await member.get("/api/brain/state")).body.synergyResearch,undefined);
  const csrf = await readCsrfToken(admin, "/brain");
  const endpoint = "/api/brain/tools/agent:researcher";
  await member.put(endpoint).set("X-CSRF-Token",await readCsrfToken(member, "/brain")).send({version:0,tools:["synergy-mcp"]}).expect(403);
  await admin.put(endpoint).send({version:0,tools:["synergy-mcp"]}).expect(403);
  const before = (await admin.get("/api/brain/tools").expect(200).expect("Cache-Control","no-store")).body;
  assert.ok(!before.policy.assignments["agent:researcher"].includes("synergy-mcp"));
  const result = await admin.put(endpoint).set("X-CSRF-Token",csrf).send({version:0,tools:["synergy-mcp"]}).expect(200);
  assert.equal(result.body.policy.history[0].actorId,"discord:operator");
  await admin.put(endpoint).set("X-CSRF-Token",csrf).send({version:0,tools:[]}).expect(409);
  await admin.put(endpoint).set("X-CSRF-Token",csrf).send({version:1,tools:["arbitrary.sql"]}).expect(400);
  assert.ok(!(await app.locals.brainTools.definitions("researcher")).some(tool=>tool.name==="synergy.read"),"Module gate must still be enabled");
  await admin.get("/api/brain/synergy/search?query=NQ").expect(200);
  assert.equal(sourceCalls,1);
});

test("PostgreSQL tool assignments persist and concurrent admins cannot overwrite changes", {skip:!process.env.TEST_BRAIN_TOOL_POLICY_DATABASE_URL}, async t => {
  const connectionString = process.env.TEST_BRAIN_TOOL_POLICY_DATABASE_URL;
  assert.equal(new URL(connectionString).pathname,"/brain_tools_test");
  const pool = new pg.Pool({connectionString}); t.after(()=>pool.end());
  await pool.query(await readFile(new URL("../../migrations/008_brain_tool_policy.sql",import.meta.url),"utf8"));
  await pool.query("TRUNCATE brain_tool_policy");
  const first = createBrainToolPolicy({repository:createPostgresBrainToolPolicyRepository(pool)});
  await first.update("agent:researcher",{version:0,tools:["synergy-mcp"]},"admin-a");
  const second = createBrainToolPolicy({repository:createPostgresBrainToolPolicyRepository(pool)});
  assert.deepEqual((await second.read()).assignments["agent:researcher"],["synergy-mcp"]);
  const results = await Promise.allSettled([first.update("module:retrieval",{version:1,tools:["synergy-mcp"]},"admin-a"),second.update("agent:critic",{version:1,tools:[]},"admin-b")]);
  assert.equal(results.filter(item=>item.status==="fulfilled").length,1);
  assert.equal(results.find(item=>item.status==="rejected").reason.code,"BRAIN_TOOL_POLICY_CONFLICT");
  assert.equal((await first.read()).version,2);
});
