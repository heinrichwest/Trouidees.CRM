import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serveCrmStaticFile } from "../lib/crm-static-files.mjs";

test("static serving returns JavaScript MIME for the activity loader module", async () => {
  const publicRoot = resolve(fileURLToPath(new URL("../public", import.meta.url)));
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };

  await serveCrmStaticFile(publicRoot, "/activity-loader.mjs", response);

  assert.equal(response.status, 200);
  assert.equal(response.headers["Content-Type"], "text/javascript; charset=utf-8");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.match(response.body.toString("utf8"), /createSelectedActivityLoader/);
});
