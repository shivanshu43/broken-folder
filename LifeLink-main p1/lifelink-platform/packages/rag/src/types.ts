export type LifeLinkRole =
  | "USER"
  | "ADMINISTRATOR"
  | "HOSPITAL_USER"
  | "BLOOD_BANK_USER"
  | "ORGAN_CENTRE_USER";

export type QueryIntent =
  | "KNOWLEDGE"
  | "REQUEST_STATUS"
  | "LIVE_INVENTORY"
  | "FACILITY_DISCOVERY"
  | "WORKFLOW_ACTION"
  | "MEDICAL_OR_CLINICAL"
  | "UNKNOWN";

export interface KnowledgeSourceDefinition {
  sourceKey: string;
  relativePath: string;
  title: string;
  sourceType: "FAQ" | "WORKFLOW" | "POLICY" | "SRS" | "ARCHITECTURE";
  visibilityRoles: LifeLinkRole[];
  description: string;
}

export interface KnowledgeChunkInput {
  sourceKey: string;
  title: string;
  sourceType: string;
  relativePath: string;
  chunkIndex: number;
  content: string;
  heading?: string;
  version: string;
  visibilityRoles: LifeLinkRole[];
}

export interface RetrievedKnowledgeChunk {
  id: string;
  sourceKey: string;
  title: string;
  sourceType: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface KnowledgeSourceStatus {
  sourceKey: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  indexedAt?: string | null;
}

export interface AssistantSourceReference {
  sourceKey: string;
  title: string;
  similarity: number;
}

export interface AssistantAnswer {
  answer: string;
  intent: QueryIntent;
  knowledgeUsed: boolean;
  liveDataUsed: boolean;
  sources: AssistantSourceReference[];
  limitations: string[];
  handoff?: {
    label: string;
    href: string;
    reason: string;
  };
}
