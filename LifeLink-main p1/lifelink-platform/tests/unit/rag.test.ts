import assert from "node:assert/strict";
import test from "node:test";
import { classifyQueryIntent } from "../../packages/rag/src/intent";
import { chunkDocument } from "../../packages/rag/src/knowledge-sources";
import { extractLocationQuery } from "../../apps/api/src/modules/rag/live-context";

test("RAG intent classification separates platform instructions from live data", () => {
  assert.equal(classifyQueryIntent("How does the blood request workflow work?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("How do I submit a blood request?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("What is the meaning of Reserved status?"), "KNOWLEDGE");
  assert.equal(classifyQueryIntent("What is the status of my request?"), "REQUEST_STATUS");
  assert.equal(classifyQueryIntent("What is the current inventory for O+?"), "LIVE_INVENTORY");
  assert.equal(classifyQueryIntent("Check current inventory for O+"), "LIVE_INVENTORY");
  assert.equal(classifyQueryIntent("Find nearby blood donation centres in Indore"), "FACILITY_DISCOVERY");
  assert.equal(classifyQueryIntent("Cancel my blood request"), "WORKFLOW_ACTION");
  assert.equal(classifyQueryIntent("Should I take medicine for chest pain?"), "MEDICAL_OR_CLINICAL");
});

test("document chunking preserves text and bounds chunk size with overlap", () => {
  const content = [
    "# Blood Workflow",
    "A blood request is validated and saved before matching starts.",
    "Institutions can respond to offers. Accepted offers follow the reservation workflow.",
    "The status shown by the operational application is authoritative.",
  ].join("\n\n");
  const chunks = chunkDocument(content, 500, 80);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 500));
  assert.ok(chunks.some((chunk) => chunk.heading === "Blood Workflow"));
  assert.ok(chunks.map((chunk) => chunk.content).join("\n").includes("reservation workflow"));
});

test("long paragraphs are chunked without exceeding limits or looping on the final overlap", () => {
  const longParagraph = Array.from({ length: 1200 }, (_, index) => `token${index}`).join(" ");
  const chunks = chunkDocument(longParagraph, 500, 80);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((chunk) => chunk.content.length <= 500));
  assert.ok(chunks[0].content.startsWith("token0"));
  assert.ok(chunks[chunks.length - 1].content.includes("token1199"));
});

test("location extraction builds a geocoding query from an explicitly supplied area", () => {
  assert.equal(
    extractLocationQuery("I live in Indore, near Vijay Nagar. Can you find nearby blood donation centres?"),
    "Vijay Nagar, Indore, India",
  );
  assert.equal(extractLocationQuery("Find a nearby blood bank"), null);
  assert.equal(extractLocationQuery("Find a blood bank near Vijay Nagar, Indore."), "Vijay Nagar, Indore, India");
});
