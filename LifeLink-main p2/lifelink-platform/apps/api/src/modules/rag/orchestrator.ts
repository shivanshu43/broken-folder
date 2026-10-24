import { randomUUID } from "node:crypto";
import type { AuthContext } from "../../middleware/auth";
import {
  buildGroundedPrompt,
  classifyQueryIntent,
  generateGroundedText,
  getNoEvidenceAnswer,
  listKnowledgeSourcesForRole,
  postProcessAssistantResponse,
  retrieveRelevantChunks,
  LIFELINK_RAG_SYSTEM_INSTRUCTION,
  type AssistantAnswer,
  type ConversationTurn,
  type LifeLinkRole,
  type QueryIntent,
  type RetrievedKnowledgeChunk,
} from "@lifelink/rag";

const LIVE_INTENTS: QueryIntent[] = ["REQUEST_STATUS", "LIVE_INVENTORY", "FACILITY_DISCOVERY"];

function toRagRole(role: AuthContext["role"]): LifeLinkRole {
  if (role === "USER" || role === "ADMINISTRATOR" || role === "HOSPITAL_USER" ||
      role === "BLOOD_BANK_USER" || role === "ORGAN_CENTRE_USER") return role;
  return "USER";
}

function handoffForAction(message: string, actor: AuthContext): AssistantAnswer["handoff"] {
  const normalized = message.toLocaleLowerCase();
  if (/\b(organ|transplant|recipient|organ donor|organ centre|organ center|organ consent)\b/.test(normalized)) {
    return actor.principalType === "INSTITUTION"
      ? { label: "Open Organ Centre", href: "/organ-centre", reason: "Organ actions must be completed through the authenticated organ-coordination workflow." }
      : { label: "Open Organ Services", href: "/organ-services", reason: "Donor or recipient actions must be completed through the existing authenticated workflow." };
  }
  if (/\b(blood donor|donate blood|blood donation|blood donor registration)\b/.test(normalized)) {
    return { label: "Find Blood-Service Facilities", href: "/map", reason: "The current application does not provide a general blood-donor pledge form or camp calendar. Use the map to find registered blood-service facilities and confirm donation arrangements with them." };
  }
  if (/\b(inventory|blood bank|blood centre|blood center|stock)\b/.test(normalized)) {
    return { label: "Open Inventory", href: "/inventory", reason: "Inventory changes require the validated institution workflow." };
  }
  return { label: "Open Requests", href: "/requests", reason: "Request actions must be completed through the existing authenticated workflow." };
}

function buildSourceReferences(chunks: RetrievedKnowledgeChunk[]) {
  const unique = new Map<string, { sourceKey: string; title: string; similarity: number }>();
  for (const chunk of chunks) {
    const previous = unique.get(chunk.sourceKey);
    if (!previous || chunk.similarity > previous.similarity) {
      unique.set(chunk.sourceKey, {
        sourceKey: chunk.sourceKey,
        title: chunk.title,
        similarity: chunk.similarity,
      });
    }
  }
  return [...unique.values()].sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

function buildRetrievalQuery(message: string, history: ConversationTurn[]): string {
  const normalized = message.trim();
  const followUp = normalized.length < 80 ||
    /^(and|then|what about|why|how about|what happens next|after that|it|that|those|they)\b/i.test(normalized);
  if (!followUp) return normalized;
  const previousUser = [...history].reverse().find((turn) => turn.role === "user")?.content;
  return previousUser ? `Previous question: ${previousUser}\nFollow-up question: ${normalized}` : normalized;
}

export function detectQueryIntent(message: string): QueryIntent {
  return classifyQueryIntent(message);
}

// Read-only operational lookup. State-changing work is always handed back to the existing application workflow.
export async function fetchLiveContext(
  message: string,
  actor: AuthContext,
  intent: QueryIntent,
) {
  return fetchLiveContextImpl(message, actor, intent);
}

import { fetchLiveContext as fetchLiveContextImpl } from "./live-context";

// Assemble the approved evidence and conversational context before generation.
export function assembleGroundedContext(
  message: string,
  actor: AuthContext,
  history: ConversationTurn[],
  chunks: RetrievedKnowledgeChunk[],
): string {
  return buildGroundedPrompt({
    message,
    role: toRagRole(actor.role),
    history,
    chunks,
  });
}

export async function generateAssistantResponse(input: {
  message: string;
  actor: AuthContext;
  history: ConversationTurn[];
}): Promise<AssistantAnswer> {
  const { message, actor, history } = input;
  const intent = detectQueryIntent(message);
  const role = toRagRole(actor.role);

  if (intent === "MEDICAL_OR_CLINICAL") {
    const emergency = /\b(chest pain|can't breathe|cannot breathe|severe bleeding|unconscious|overdose|life[- ]threatening|emergency)\b/i.test(message);
    return {
      answer: emergency
        ? "This may require urgent medical attention. Please contact local emergency services or go to the nearest emergency department now. Do not delay care while using the LifeLink assistant. I can help explain LifeLink platform workflows, but I cannot assess or treat a medical emergency."
        : "LifeLink's Smart FAQ Assistant is intended to explain platform workflows and approved LifeLink documentation, not to diagnose symptoms or make medical decisions. Please speak with a qualified healthcare professional for clinical guidance.",
      intent,
      knowledgeUsed: false,
      liveDataUsed: false,
      sources: [],
      limitations: ["This assistant does not provide diagnosis, prescriptions, transfusion decisions, donor eligibility decisions, or final organ-allocation decisions."],
    };
  }

  if (intent === "WORKFLOW_ACTION") {
    const handoff = handoffForAction(message, actor);
    return {
      answer: `I can guide you through LifeLink, but I haven't submitted or changed anything. Please continue in the existing workflow so the application can validate your details, verify your permissions, and record the action.`,
      intent,
      knowledgeUsed: false,
      liveDataUsed: false,
      sources: [],
      limitations: ["No request, inventory, offer, consent, or other operational record was changed by this answer."],
      handoff,
    };
  }

  if (LIVE_INTENTS.includes(intent)) {
    const live = await fetchLiveContext(message, actor, intent);
    if (live) {
      return {
        answer: live.answer,
        intent: live.intent,
        knowledgeUsed: false,
        liveDataUsed: live.liveDataUsed,
        sources: [],
        limitations: live.liveDataUsed
          ? ["The result reflects records returned by LifeLink at query time. Availability and status can change; confirm with the responsible institution. This is not a clinical or allocation decision."]
          : ["No live result was confirmed. The assistant has not substituted retrieved documents or generated text for operational records."],
        handoff: live.handoff,
      };
    }
    // A live-data intent must never silently fall back to stale indexed text.
    return {
      answer: "I couldn't confirm that from LifeLink's live records right now. Please use the linked LifeLink workflow and retry shortly.",
      intent,
      knowledgeUsed: false,
      liveDataUsed: false,
      sources: [],
      limitations: ["No live operational record was confirmed; indexed documents were not used as a substitute."],
    };
  }

  const retrievalQuery = buildRetrievalQuery(message, history);
  const chunks = await retrieveRelevantChunks(retrievalQuery, role);
  const sources = buildSourceReferences(chunks);

  if (!chunks.length) {
    return {
      answer: getNoEvidenceAnswer(),
      intent: "UNKNOWN",
      knowledgeUsed: false,
      liveDataUsed: false,
      sources: [],
      limitations: ["No sufficiently relevant approved knowledge passages were retrieved."],
    };
  }

  const prompt = assembleGroundedContext(message, actor, history, chunks);
  let answer: string;
  try {
    answer = postProcessAssistantResponse(
      await generateGroundedText(LIFELINK_RAG_SYSTEM_INSTRUCTION, prompt),
    );
  } catch (error) {
    console.error("LifeLink assistant generation failed", error instanceof Error ? error.name : "UnknownError");
    return {
      answer: "I found related LifeLink documentation, but the answer service is temporarily unavailable. Please retry shortly. The source documents are listed below so you can still review the documented information.",
      intent,
      knowledgeUsed: true,
      liveDataUsed: false,
      sources,
      limitations: ["Generation was unavailable. No unsupported answer was generated."],
    };
  }

  return {
    answer,
    intent,
    knowledgeUsed: true,
    liveDataUsed: false,
    sources,
    limitations: ["This response is grounded in approved documentation, not live inventory or request data."],
  };
}

export async function listVisibleKnowledgeSources(actor: AuthContext) {
  return listKnowledgeSourcesForRole(toRagRole(actor.role));
}

export function createAssistantInteractionId() {
  return randomUUID();
}
