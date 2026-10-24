import {
  BloodComponent,
  BloodGroup,
  BloodInventoryStatus,
  InstitutionStatus,
  InstitutionType,
  RequestType,
} from "@prisma/client";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { calculateDistance } from "../maps/geospatial.service";
import type { QueryIntent } from "@lifelink/rag";

type Coordinates = { latitude: number; longitude: number; displayName?: string } | null;
type LiveOutcome = {
  answer: string;
  intent: QueryIntent;
  liveDataUsed: boolean;
  handoff?: { label: string; href: string; reason: string };
  data?: Record<string, unknown>;
  needsClarification?: boolean;
};

const locationCache = new Map<string, { value: Coordinates; expiresAt: number }>();
let geocodeQueue: Promise<void> = Promise.resolve();
let nextGeocodeAt = 0;

function extractLocationParts(query: string): string[] {
  const parts = query.split(/[,;.!?\n]+/).map((part) => part.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (const part of parts) {
    const match = part.match(/\b(?:close to|near|around|located in|live in|living in|based in|in|at)\s+(.+)$/i);
    if (!match) continue;
    let place = match[1]
      .replace(/\b(?:can you|could you|please|find|search|show|check|look up|recommend|tell me|where|what|how)\b.*$/i, "")
      .replace(/\b(?:please|nearby|nearest|closest)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
      .trim();
    if (place.length >= 2 && place.length <= 80 && !/^(?:the|a|an|some)$/i.test(place)) {
      if (!candidates.some((existing) => existing.toLocaleLowerCase() === place.toLocaleLowerCase())) {
        candidates.push(place);
      }
    }
  }
  // More specific locality first, followed by its city/region.
  return candidates.reverse().slice(0, 3);
}

export function extractLocationQuery(query: string): string | null {
  // Preserve the common "near <locality>, <city>" form before punctuation
  // splitting would otherwise discard the bare city segment.
  const localityCity = query.match(/\b(?:near|around|close to)\s+([^,;.!?\n]+)\s*,\s*([^,;.!?\n]+)/i);
  if (localityCity) {
    const locality = localityCity[1].replace(/^\s*(?:the|a|an)\s+/i, "").trim();
    const city = localityCity[2]
      .replace(/\b(?:can you|could you|please|find|search|show|check|look up|recommend|tell me|where|what|how)\b.*$/i, "")
      .replace(/^\s*(?:the|a|an)\s+/i, "")
      .trim();
    if (locality.length >= 2 && locality.length <= 80 && city.length >= 2 && city.length <= 80) {
      return `${locality}, ${city}, India`;
    }
  }
  const parts = extractLocationParts(query);
  if (!parts.length) return null;
  return `${parts.join(", ")}, India`;
}

async function geocodeLocation(location: string): Promise<Coordinates> {
  const cacheKey = location.toLocaleLowerCase().trim();
  const cached = locationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const task = geocodeQueue.then(async () => {
    const delay = Math.max(0, nextGeocodeAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextGeocodeAt = Date.now() + 1_100;

    const endpoint = (process.env.GEOCODING_ENDPOINT || "https://nominatim.openstreetmap.org/search").replace(/\/+$/, "");
    const url = new URL(endpoint);
    url.searchParams.set("q", location);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "in");
    const response = await fetch(url, {
      headers: {
        "User-Agent": process.env.GEOCODING_USER_AGENT || "LifeLinkPlatform/1.0 (location-aware assistant)",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const rows = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string; type?: string; addresstype?: string }>;
    const row = rows[0];
    if (!row || row.type === "country" || row.addresstype === "country") return null;
    const latitude = Number(row.lat);
    const longitude = Number(row.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude, displayName: row.display_name };
  });
  geocodeQueue = task.then(() => undefined, () => undefined);

  let value: Coordinates = null;
  try {
    value = await task;
  } catch {
    value = null;
  }
  locationCache.set(cacheKey, { value, expiresAt: Date.now() + (value ? 10 : 1) * 60_000 });
  return value;
}

function radiusFromQuery(query: string, nearby: boolean): number | undefined {
  const explicit = query.match(/\bwithin\s+(\d{1,3})\s*(?:km|kilomet(?:er|re)s?)\b/i);
  if (explicit) {
    const value = Number(explicit[1]);
    if (value >= 1 && value <= 500) return value;
  }
  return nearby ? 25 : undefined;
}

function parseBloodGroup(query: string): BloodGroup | null {
  const value = query.toLocaleLowerCase()
    .replace(/[+＋]/g, " positive ")
    .replace(/[−–-]/g, " negative ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  const groups: Array<[RegExp, BloodGroup]> = [
    [/\bab\s+positive\b/i, BloodGroup.AB_POSITIVE],
    [/\bab\s+negative\b/i, BloodGroup.AB_NEGATIVE],
    [/\ba\s+positive\b/i, BloodGroup.A_POSITIVE],
    [/\ba\s+negative\b/i, BloodGroup.A_NEGATIVE],
    [/\bb\s+positive\b/i, BloodGroup.B_POSITIVE],
    [/\bb\s+negative\b/i, BloodGroup.B_NEGATIVE],
    [/\bo\s+positive\b/i, BloodGroup.O_POSITIVE],
    [/\bo\s+negative\b/i, BloodGroup.O_NEGATIVE],
  ];
  for (const [pattern, group] of groups) if (pattern.test(value)) return group;
  return null;
}
function parseComponent(query: string): BloodComponent | undefined {
  if (/\b(whole blood)\b/i.test(query)) return BloodComponent.WHOLE_BLOOD;
  if (/\b(red blood cells?|rbc|packed cells?)\b/i.test(query)) return BloodComponent.RED_BLOOD_CELLS;
  if (/\b(plasma)\b/i.test(query)) return BloodComponent.PLASMA;
  if (/\b(platelets?)\b/i.test(query)) return BloodComponent.PLATELETS;
  if (/\b(cryoprecipitate|cryo)\b/i.test(query)) return BloodComponent.CRYOPRECIPITATE;
  return undefined;
}

function displayBloodGroup(group: string) {
  return group.replace("_POSITIVE", "+").replace("_NEGATIVE", "-").replaceAll("_", " ");
}

async function findRequestStatus(query: string, actor: AuthContext): Promise<LiveOutcome> {
  const id = query.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0];
  if (id) {
    const record = await database.request.findUnique({
      where: { id },
      select: {
        id: true, requestType: true, status: true, priority: true, requestDate: true,
        location: true, createdById: true, createdByInstitutionId: true,
        recipients: { select: { userId: true } },
        matches: { select: {
          status: true, providerInstitutionId: true, reservationExpiresAt: true,
          dispatchedAt: true, receivedAt: true,
          providerInstitution: { select: { name: true } },
        } },
      },
    });
    if (record) {
      const permitted = actor.role === "ADMINISTRATOR" ||
        (actor.principalType === "USER" && (
          record.createdById === actor.userId ||
          record.recipients.some((recipient) => recipient.userId === actor.userId)
        )) ||
        (actor.principalType === "INSTITUTION" && (
          record.createdByInstitutionId === actor.institutionId ||
          record.matches.some((match) => match.providerInstitutionId === actor.institutionId)
        ));
      if (!permitted) {
        return {
          answer: "I couldn't retrieve that record in your current access scope. Please open the Requests page and select a request you are authorized to view.",
          intent: "REQUEST_STATUS",
          liveDataUsed: false,
          handoff: { label: "Open Requests", href: "/requests", reason: "Request details are protected and must be viewed through the authenticated workflow." },
        };
      }
      const label = record.requestType === RequestType.BLOOD ? "blood request" : "organ-related request";
      const lines = [
        `I checked the current LifeLink record for your ${label}.`,
        `**Status:** ${record.status.replaceAll("_", " ")}.`,
        `**Priority:** ${record.priority}.`,
        `**Created:** ${record.requestDate.toISOString()}.`,
      ];
      if (record.matches.length) {
        const offers = record.matches.slice(0, 5).map((match) =>
          `${match.providerInstitution?.name ?? "Participating institution"} — ${match.status.replaceAll("_", " ")}`,
        );
        lines.push(`**Recorded offers/matches:** ${offers.join("; ")}.`);
      }
      lines.push("This is the status currently recorded by LifeLink; it does not guarantee fulfilment or clinical suitability.");
      return {
        answer: lines.join("\n\n"),
        intent: "REQUEST_STATUS",
        liveDataUsed: true,
        data: { recordType: label, status: record.status, requestDate: record.requestDate.toISOString() },
        handoff: { label: "Open Requests", href: "/requests", reason: "Open the record for its full, role-authorized details." },
      };
    }

    const organRecipient = await database.organRecipient.findUnique({
      where: { id },
      select: { id: true, reference: true, status: true, organType: true, priority: true, createdAt: true, userId: true, institutionId: true },
    });
    if (organRecipient) {
      const permitted = actor.role === "ADMINISTRATOR" ||
        (actor.principalType === "USER" && organRecipient.userId === actor.userId) ||
        (actor.principalType === "INSTITUTION" && organRecipient.institutionId === actor.institutionId);
      if (permitted) {
        return {
          answer: `I checked the current LifeLink recipient record **${organRecipient.reference}**. Its recorded status is **${organRecipient.status.replaceAll("_", " ")}**. Organ matching and allocation remain subject to authorized professional review; this status is not a clinical decision.`,
          intent: "REQUEST_STATUS",
          liveDataUsed: true,
          data: { recordType: "organ recipient requirement", status: organRecipient.status },
          handoff: { label: "Open Organ Services", href: actor.principalType === "INSTITUTION" ? "/organ-centre/recipients" : "/organ-services", reason: "Open the authorized recipient workflow for full details." },
        };
      }
    }

    return {
      answer: "I couldn't find a request record that is available in your current access scope. Check the reference and try again, or open Requests to select one of your records.",
      intent: "REQUEST_STATUS",
      liveDataUsed: false,
      handoff: { label: "Open Requests", href: "/requests", reason: "Select a request you are authorized to view." },
    };
  }

  if (actor.role === "ADMINISTRATOR") {
    return {
      answer: "Please provide the LifeLink request or recipient reference you want to check. I won't choose an arbitrary record from the system.",
      intent: "REQUEST_STATUS",
      liveDataUsed: false,
      needsClarification: true,
    };
  }

  const where = actor.principalType === "USER"
    ? { OR: [{ createdById: actor.userId }, { recipients: { some: { userId: actor.userId } } }] }
    : { OR: [{ createdByInstitutionId: actor.institutionId }, { matches: { some: { providerInstitutionId: actor.institutionId } } }] };
  const requests = await database.request.findMany({
    where,
    select: { id: true, requestType: true, status: true, priority: true, requestDate: true },
    orderBy: { requestDate: "desc" },
    take: 5,
  });
  if (!requests.length) {
    return {
      answer: "I couldn't find a recent request associated with this account. Open Requests to start or select a workflow, or share the request reference if you have it.",
      intent: "REQUEST_STATUS",
      liveDataUsed: true,
      handoff: { label: "Open Requests", href: "/requests", reason: "View or start an authorized request workflow." },
    };
  }
  const list = requests.map((item) =>
    `- ${item.requestType === RequestType.BLOOD ? "Blood request" : "Organ request"} ending **${item.id.slice(0, 8)}** — **${item.status.replaceAll("_", " ")}**, ${item.priority.toLowerCase()}, created ${item.requestDate.toISOString()}`,
  );
  return {
    answer: `Here are the latest requests visible to this account:\n\n${list.join("\n")}\n\nThese statuses come from LifeLink's operational database. Open a record in Requests for the full authorized details.`,
    intent: "REQUEST_STATUS",
    liveDataUsed: true,
    handoff: { label: "Open Requests", href: "/requests", reason: "View the full status and eligible next steps." },
  };
}

async function searchLiveInventory(query: string): Promise<LiveOutcome> {
  const bloodGroup = parseBloodGroup(query);
  if (!bloodGroup) {
    return {
      answer: "Which blood group should I look for (for example, O+, A−, or AB+)? You can also mention a component such as red blood cells, plasma, or platelets, and your city/locality if you want nearby results.",
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "You can also search using the structured inventory filters." },
    };
  }

  const location = extractLocationQuery(query);
  const nearby = /\b(nearby|nearest|closest|around me|near me|within)\b/i.test(query);
  let coords: Coordinates = null;
  if (location) coords = await geocodeLocation(location);
  if (location && !coords) {
    return {
      answer: `I couldn't reliably resolve **${location.replace(/,\s*India$/i, "")}** to a map location, so I won't label facilities as nearby. Please provide a more specific locality and city, or use the map page.`,
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "Use the map to choose a location." },
    };
  }
  if (nearby && !location) {
    return {
      answer: "What city or locality should I search around? I don't assume or access a device location automatically.",
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Choose a location and search radius in the structured form." },
    };
  }

  const component = parseComponent(query);
  const records = await database.bloodInventory.findMany({
    where: {
      bloodGroup,
      ...(component ? { component } : {}),
      status: BloodInventoryStatus.AVAILABLE,
      unitsAvailable: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      institution: {
        status: InstitutionStatus.ACTIVE,
        deletedAt: null,
        OR: [
          { type: InstitutionType.BLOOD_BANK },
          { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } },
        ],
      },
    },
    select: {
      id: true, bloodGroup: true, component: true, unitsAvailable: true, reservedUnits: true,
      lastUpdated: true, expiryDate: true,
      institution: { select: { id: true, name: true, type: true, address: true, latitude: true, longitude: true, contactNumber: true } },
    },
    orderBy: { lastUpdated: "desc" },
    take: 100,
  });

  const radius = radiusFromQuery(query, nearby || Boolean(coords));
  const now = Date.now();
  const candidates = records.flatMap((record) => {
    let distanceKm: number | undefined;
    if (coords && record.institution.latitude !== null && record.institution.longitude !== null) {
      distanceKm = calculateDistance(coords.latitude, coords.longitude, record.institution.latitude, record.institution.longitude);
    }
    if (coords && radius !== undefined && (distanceKm === undefined || distanceKm > radius)) return [];
    const ageMinutes = (now - record.lastUpdated.getTime()) / 60_000;
    return [{
      group: displayBloodGroup(record.bloodGroup),
      component: record.component.replaceAll("_", " "),
      unitsAvailable: record.unitsAvailable,
      institution: record.institution.name,
      address: record.institution.address,
      contactNumber: record.institution.contactNumber,
      distanceKm: distanceKm === undefined ? null : Math.round(distanceKm * 10) / 10,
      lastUpdated: record.lastUpdated.toISOString(),
      stale: ageMinutes > 24 * 60,
      expiryDate: record.expiryDate?.toISOString() ?? null,
    }];
  }).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || b.unitsAvailable - a.unitsAvailable).slice(0, 8);

  if (!candidates.length) {
    return {
      answer: `I couldn't find an active, non-expired LifeLink inventory record for **${displayBloodGroup(bloodGroup)}**${component ? ` (${component.replaceAll("_", " ").toLowerCase()})` : ""}${coords && radius !== undefined ? ` within ${radius} km of ${coords.displayName ?? location}` : ""}. This means no matching record was found in the current LifeLink data; it does not prove that no blood is available elsewhere. Please confirm with a participating facility or use Inventory Search.`,
      intent: "LIVE_INVENTORY",
      liveDataUsed: true,
      data: { resultCount: 0, searchedGroup: bloodGroup, component: component ?? null, radiusKm: radius ?? null },
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Run a structured search and confirm the result with the institution." },
    };
  }

  const lines = candidates.map((item, index) => {
    const details = [
      `${index + 1}. **${item.institution}**`,
      `${item.address}`,
      `**${item.unitsAvailable}** unit(s) recorded for ${item.group} ${item.component}.`,
      item.distanceKm !== null ? `Approx. ${item.distanceKm} km away.` : "",
      item.contactNumber ? `Facility contact: ${item.contactNumber}.` : "",
      `Inventory last updated: ${item.lastUpdated}.`,
      item.stale ? "⚠️ This record has not been updated in the last 24 hours; confirm directly with the facility." : "",
      item.expiryDate ? `Recorded expiry date: ${item.expiryDate}.` : "",
    ].filter(Boolean);
    return details.join("\n");
  });
  const scopeLine = coords && radius !== undefined
    ? `I checked active LifeLink blood-bank/hospital inventory within ${radius} km of ${coords.displayName ?? location}.`
    : "I checked the current inventory records at participating LifeLink facilities; because no search location was provided, these results are not ranked by proximity.";
  return {
    answer: `${scopeLine}\n\n${lines.join("\n\n")}\n\nThese are current database records, not a guarantee of availability. Please contact the facility to confirm before travelling or making care decisions.`,
    intent: "LIVE_INVENTORY",
    liveDataUsed: true,
    data: { resultCount: candidates.length, searchedGroup: bloodGroup, component: component ?? null, radiusKm: radius ?? null, candidates },
    handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Use the structured search to refine the request and view the full current records." },
  };
}

async function discoverLiveFacilities(query: string): Promise<LiveOutcome> {
  const location = extractLocationQuery(query);
  if (!location) {
    return {
      answer: "Which city or locality should I search around? Share a locality and city (for example, “Vijay Nagar, Indore”) and I’ll check registered LifeLink facility records rather than inventing a centre.",
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "The map lets you choose a location and facility type." },
    };
  }
  const coords = await geocodeLocation(location);
  if (!coords) {
    return {
      answer: `I couldn't resolve **${location.replace(/,\s*India$/i, "")}** to reliable coordinates. Please provide a more specific locality and city, or use the map page. I won't recommend a facility as nearby without usable location information.`,
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "Choose a location for facility discovery." },
    };
  }

  const wantsOrgan = /\b(organ|transplant|organ centre|organ center)\b/i.test(query);
  const wantsBlood = /\b(blood|donat(?:e|ion)|blood bank|blood centre|blood center|camp)\b/i.test(query);
  const typeFilter = wantsOrgan
    ? [{ type: InstitutionType.ORGAN_CENTRE }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { organService: { isNot: null } } } }]
    : wantsBlood
      ? [{ type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } }]
      : [{ type: InstitutionType.HOSPITAL }, { type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.ORGAN_CENTRE }];

  const institutions = await database.institution.findMany({
    where: { status: InstitutionStatus.ACTIVE, deletedAt: null, OR: typeFilter },
    select: {
      id: true, name: true, type: true, address: true, contactNumber: true,
      latitude: true, longitude: true, updatedAt: true,
    },
    take: 500,
  });
  const radius = radiusFromQuery(query, true) ?? 25;
  const candidates = institutions.flatMap((institution) => {
    if (institution.latitude === null || institution.longitude === null) return [];
    const distanceKm = calculateDistance(coords.latitude, coords.longitude, institution.latitude, institution.longitude);
    if (distanceKm > radius) return [];
    return [{
      name: institution.name,
      type: institution.type.replaceAll("_", " "),
      address: institution.address,
      contactNumber: institution.contactNumber,
      distanceKm: Math.round(distanceKm * 10) / 10,
      updatedAt: institution.updatedAt.toISOString(),
    }];
  }).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 8);

  const missingCoordinates = institutions.some((institution) => institution.latitude === null || institution.longitude === null);
  const asksCamp = /\b(camp|camps|upcoming)\b/i.test(query);
  if (!candidates.length) {
    return {
      answer: `I couldn't find a registered, active ${wantsOrgan ? "organ-service" : wantsBlood ? "blood-service" : "healthcare"} facility with usable coordinates within ${radius} km of ${coords.displayName ?? location}. ${missingCoordinates ? "Some registered institutions do not have coordinates, so they could not be confirmed as nearby. " : ""}Try the map page or ask an administrator to update facility location data.`,
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: true,
      data: { resultCount: 0, radiusKm: radius, location: coords.displayName ?? location },
      handoff: { label: "Open Map", href: "/map", reason: "View registered facilities and refine the location search." },
    };
  }

  const lines = candidates.map((item, index) => [
    `${index + 1}. **${item.name}** (${item.type})`,
    item.address,
    `Approx. ${item.distanceKm} km away.`,
    item.contactNumber ? `Facility contact: ${item.contactNumber}.` : "",
    `Profile last updated: ${item.updatedAt}.`,
  ].filter(Boolean).join("\n"));
  const campNote = asksCamp
    ? "\n\nLifeLink's current data model does not include a scheduled blood-donation-camp calendar, so I can identify registered facilities but cannot confirm upcoming camp dates."
    : "";
  return {
    answer: `I checked registered, active LifeLink facilities within ${radius} km of ${coords.displayName ?? location}:\n\n${lines.join("\n\n")}${missingCoordinates ? "\n\nSome other registered facilities lack coordinates and could not be ranked by distance." : ""}${campNote}\n\nThese are facility records, not a guarantee of current services or donation availability. Contact the facility to confirm before travelling.`,
    intent: "FACILITY_DISCOVERY",
    liveDataUsed: true,
    data: { resultCount: candidates.length, radiusKm: radius, location: coords.displayName ?? location, facilities: candidates, scheduledCampsAvailable: false },
    handoff: { label: "Open Map", href: "/map", reason: "View locations and continue facility discovery." },
  };
}

export async function fetchLiveContext(query: string, actor: AuthContext, intent: QueryIntent): Promise<LiveOutcome | null> {
  try {
    if (intent === "REQUEST_STATUS") return await findRequestStatus(query, actor);
    if (intent === "LIVE_INVENTORY") return await searchLiveInventory(query);
    if (intent === "FACILITY_DISCOVERY") return await discoverLiveFacilities(query);
    return null;
  } catch (error) {
    // External geocoding and live data dependencies fail closed. Never fall back to invented results.
    if (error instanceof ApiError) throw error;
    console.error("LifeLink assistant live-data lookup failed", error instanceof Error ? error.name : "UnknownError");
    return {
      answer: "I couldn't access the live LifeLink data needed for that request right now. No live result has been confirmed. Please use the relevant LifeLink page and try again shortly.",
      intent,
      liveDataUsed: false,
      handoff: intent === "REQUEST_STATUS"
        ? { label: "Open Requests", href: "/requests", reason: "Check your authorized request records." }
        : intent === "LIVE_INVENTORY"
          ? { label: "Open Inventory Search", href: "/inventory", reason: "Search through the authenticated inventory workflow." }
          : { label: "Open Map", href: "/map", reason: "Search registered facilities through the map." },
    };
  }
}
