import type { QueryIntent } from "./types";

const HOW_QUESTION = /\b(how\s+(do|can|does|to)|what\s+(happens|does|is)|explain|walk\s+me\s+through|steps\s+to|difference\s+between|meaning\s+of|policy|rules|process|workflow|guide)\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export function classifyQueryIntent(query: string): QueryIntent {
  const value = query.trim();
  if (!value) return "UNKNOWN";

  if (/\b(diagnos(?:e|is)|prescribe|dosage|treatment for my|am i eligible|is this blood compatible|should i take|chest pain|can't breathe|cannot breathe|severe bleeding|unconscious|overdose)\b/i.test(value)) {
    return "MEDICAL_OR_CLINICAL";
  }

  // Route clearly live-data questions before generic "what is/how does" language.
  // Otherwise, e.g. "What is the status of my request?" is misclassified as FAQ.
  if (/\b(status|track|tracking|where is my|update on my|progress of my)\b/i.test(value) &&
      /\b(request|offer|reservation|donation|organ|blood|recipient|procurement)\b/i.test(value)) {
    return "REQUEST_STATUS";
  }
  if (UUID.test(value) && /\b(status|track|request|offer|organ|recipient)\b/i.test(value)) {
    return "REQUEST_STATUS";
  }

  if (/\b(available now|currently available|current inventory|live inventory|stock right now|how many units|check inventory|blood stock|units in stock)\b/i.test(value)) {
    return "LIVE_INVENTORY";
  }

  if (/\b(nearby|nearest|closest|find\s+(?:me\s+)?(?:a\s+)?(?:nearby\s+)?(?:hospital|blood bank|blood centre|blood center|organ centre|organ center|donation centre|donation center|camp)|upcoming blood donation camps?|address of a blood bank|list (?:the )?(?:nearby )?(?:blood banks|blood centres|blood centers|organ centres|organ centers|hospitals))\b/i.test(value)) {
    return "FACILITY_DISCOVERY";
  }

  // Explanatory phrasing should retrieve workflow knowledge instead of handing off
  // to a form. Explicit live-data questions have already been handled above.
  if (HOW_QUESTION.test(value)) return "KNOWLEDGE";

  if (/\b(submit|create|cancel|reopen|accept|reject|register|enrol|enroll|withdraw|verify|authorize|schedule|dispatch|receive|donate)\b/i.test(value) &&
      /\b(request|blood|donat|donor|organ|offer|inventory|recipient|consent|procurement)\b/i.test(value)) {
    return "WORKFLOW_ACTION";
  }

  if (/\b(my request|my offer|my inventory|my donor record|my recipient record)\b/i.test(value)) return "REQUEST_STATUS";

  return "KNOWLEDGE";
}
