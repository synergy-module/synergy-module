export function createJsonResponseHarness() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(location) { this.statusCode = 302; this.location = location; return this; },
  };
}
