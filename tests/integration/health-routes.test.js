import test from "node:test";
import { createTestApp } from "../helpers/auth-test-helpers.js";
import request from "supertest";

test("health is public and reports ready dependencies", async () => {
  const app = createTestApp({ readinessCheck: async () => true });
  const response = await request(app).get("/health").expect(200);
  assertHealth(response.body, "ok");
});

test("health fails closed when a required dependency is unavailable", async () => {
  const app = createTestApp({ readinessCheck: async () => false });
  const response = await request(app).get("/health").expect(503);
  assertHealth(response.body, "unavailable");
});

function assertHealth(body, status) {
  if (body?.status !== status) throw new Error(`expected health status ${status}`);
  if (Object.keys(body).some((key) => /database|secret|url/i.test(key))) {
    throw new Error("health response exposed internal dependency details");
  }
}
