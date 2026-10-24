import { randomUUID } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import { ApiError } from "../../middleware/api-error";
import { recordAuditEvent } from "../audit/service";
import {
  createAssistantInteractionId,
  generateAssistantResponse,
  listVisibleKnowledgeSources,
} from "./orchestrator";
import { queueKnowledgeSourceProcessing } from "@lifelink/rag";

const conversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(1400),
}).strict();

const assistantQuerySchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(conversationTurnSchema).max(8).default([]),
}).strict();

const reindexSchema = z.object({
  sourceKey: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/i).optional(),
}).strict();

export function registerRagRoutes(router = Router()) {
  router.post("/query", authenticateRequest(), asyncRoute(answerAssistantQuery));
  router.get("/sources", authenticateRequest(), asyncRoute(listKnowledgeSources));
  router.post("/reindex", authenticateRequest(), authorizeAction("ADMINISTRATOR"), asyncRoute(reindexKnowledgeSource));
  return router;
}

export async function answerAssistantQuery(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  const parsed = assistantQuerySchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_ASSISTANT_QUERY", "Enter a question under 2,000 characters and at most eight recent conversation turns.", parsed.error.flatten().fieldErrors);
  }

  const interactionId = createAssistantInteractionId();
  let result;
  try {
    result = await generateAssistantResponse({
      message: parsed.data.message,
      actor: request.auth,
      history: parsed.data.history,
    });
  } catch (error) {
    console.error("LifeLink assistant request failed", error instanceof Error ? error.name : "UnknownError");
    throw new ApiError(503, "ASSISTANT_UNAVAILABLE", "The LifeLink assistant is temporarily unavailable. Please retry shortly.");
  }

  // Audit the existence and category of the interaction, not its raw text.
  try {
    await recordAuditEvent({
      actorId: request.auth.userId,
      actorInstitutionId: request.auth.institutionId,
      action: "RAG_QUERY_ANSWERED",
      entityType: "RagInteraction",
      entityId: interactionId,
      metadata: {
        intent: result.intent,
        knowledgeUsed: result.knowledgeUsed,
        liveDataUsed: result.liveDataUsed,
        sourceCount: result.sources.length,
        handoff: result.handoff?.href ?? null,
      },
    });
  } catch {
    // An FAQ reply should remain available if the optional interaction audit write fails.
    // The audit failure is not represented as successful operational state change.
    console.error("LifeLink assistant interaction audit write failed");
  }

  response.json({ ...result, interactionId, answeredAt: new Date().toISOString() });
}

export async function listKnowledgeSources(request: Request, response: Response) {
  if (!request.auth) throw new ApiError(401, "AUTH_REQUIRED", "Authentication required.");
  try {
    response.json({ sources: await listVisibleKnowledgeSources(request.auth) });
  } catch (error) {
    console.error("LifeLink knowledge source listing failed", error instanceof Error ? error.name : "UnknownError");
    throw new ApiError(503, "KNOWLEDGE_STORE_UNAVAILABLE", "Approved knowledge sources are temporarily unavailable.");
  }
}

export async function reindexKnowledgeSource(request: Request, response: Response) {
  if (request.auth?.role !== "ADMINISTRATOR") {
    throw new ApiError(403, "FORBIDDEN", "Administrator access is required to maintain the knowledge index.");
  }
  const parsed = reindexSchema.safeParse(request.body ?? {});
  if (!parsed.success) throw new ApiError(400, "INVALID_REINDEX_REQUEST", "The requested knowledge source is invalid.", parsed.error.flatten().fieldErrors);

  let outcomes;
  try {
    outcomes = await queueKnowledgeSourceProcessing(parsed.data.sourceKey);
  } catch (error) {
    console.error("LifeLink knowledge re-index failed", error instanceof Error ? error.name : "UnknownError");
    throw new ApiError(503, "KNOWLEDGE_INDEXING_FAILED", "Knowledge indexing failed. Check the server configuration and source files, then retry.");
  }

  const auditId = randomUUID();
  await recordAuditEvent({
    actorId: request.auth.userId,
    actorInstitutionId: request.auth.institutionId,
    action: "RAG_KNOWLEDGE_REINDEXED",
    entityType: "RagKnowledgeSource",
    entityId: auditId,
    metadata: {
      requestedSourceKey: parsed.data.sourceKey ?? "ALL_APPROVED",
      sourceCount: outcomes.length,
      statuses: outcomes.map((outcome) => ({ sourceKey: outcome.sourceKey, status: outcome.status, chunkCount: outcome.chunkCount })),
    },
  });
  response.json({ outcomes });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
