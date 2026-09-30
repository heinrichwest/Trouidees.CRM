import test from "node:test";
import assert from "node:assert/strict";
import { mayChangeLeadOwner, mayDeleteLead } from "../lib/crm.mjs";

test("only admins may change assignedTo, while active sales and admin users retain lead deletion", () => {
  const changes = { assignedTo: "Andrew" };
  const sales = { id: "sales", role: "sales", active: true };
  const admin = { id: "admin", role: "admin", active: true };
  assert.equal(mayChangeLeadOwner(sales, changes), false);
  assert.equal(mayChangeLeadOwner(admin, changes), true);
  assert.equal(mayChangeLeadOwner(sales, { status: "Contacted" }), true);
  assert.equal(mayDeleteLead(sales), true);
  assert.equal(mayDeleteLead(admin), true);
  assert.equal(mayDeleteLead(null), false);
});
