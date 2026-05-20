export type HubSpotObject = {
  id: string;
  properties?: Record<string, string | null>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  associations?: Record<string, { results?: Array<{ id: string; type: string }> }>;
};

export type HubSpotListResponse<T = HubSpotObject> = {
  results: T[];
  paging?: {
    next?: {
      after: string;
      link?: string;
    };
  };
};

export type HubSpotSearchFilter = {
  propertyName: string;
  operator: string;
  value?: string;
  values?: string[];
  highValue?: string;
};

export type HubSpotSearchRequest = {
  query?: string;
  filterGroups?: Array<{ filters: HubSpotSearchFilter[] }>;
  sorts?: string[];
  properties?: string[];
  limit?: number;
  after?: string;
};

const BASE_URL = "https://api.hubapi.com";

function getToken(): string {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    throw new Error("Missing HUBSPOT_PRIVATE_APP_TOKEN");
  }
  return token;
}

function toQuery(params: Record<string, string | number | boolean | undefined | string[]> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(","));
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = typeof data?.message === "string" ? data.message : response.statusText;
    throw new Error(`HubSpot API ${response.status}: ${message}`);
  }

  return data as T;
}

export async function hubspotRequest<T>(
  path: string,
  options: RequestInit & { query?: Record<string, string | number | boolean | undefined | string[]> } = {},
): Promise<T> {
  const { query, headers, body, ...rest } = options;
  const response = await fetch(`${BASE_URL}${path}${toQuery(query)}`, {
    ...rest,
    body,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
      ...headers,
    },
  });
  return parseResponse<T>(response);
}

export async function listObjects(
  objectType: string,
  properties: string[],
  limit = 25,
  after?: string,
): Promise<HubSpotListResponse> {
  return hubspotRequest<HubSpotListResponse>(`/crm/v3/objects/${objectType}`, {
    query: { limit, after, properties },
  });
}

export async function getObject(
  objectType: string,
  id: string,
  properties: string[],
  associations?: string[],
): Promise<HubSpotObject> {
  return hubspotRequest<HubSpotObject>(`/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`, {
    query: { properties, associations },
  });
}

export async function createObject(
  objectType: string,
  properties: Record<string, unknown>,
): Promise<HubSpotObject> {
  return hubspotRequest<HubSpotObject>(`/crm/v3/objects/${objectType}`, {
    method: "POST",
    body: JSON.stringify({ properties: cleanProperties(properties) }),
  });
}

export async function updateObject(
  objectType: string,
  id: string,
  properties: Record<string, unknown>,
): Promise<HubSpotObject> {
  return hubspotRequest<HubSpotObject>(`/crm/v3/objects/${objectType}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: cleanProperties(properties) }),
  });
}

export async function searchObjects(
  objectType: string,
  request: HubSpotSearchRequest,
): Promise<HubSpotListResponse> {
  return hubspotRequest<HubSpotListResponse>(`/crm/v3/objects/${objectType}/search`, {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function cleanProperties(properties: Record<string, unknown>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === "") continue;
    cleaned[key] = String(value);
  }
  return cleaned;
}

export function formatObject(title: string, object: HubSpotObject, fields: string[]): string {
  const lines = [`# ${title}`, "", "| Field | Value |", "|---|---|", `| id | \`${object.id}\` |`];
  for (const field of fields) {
    lines.push(`| ${field} | ${object.properties?.[field] ?? "-"} |`);
  }
  if (object.createdAt) lines.push(`| createdAt | ${object.createdAt} |`);
  if (object.updatedAt) lines.push(`| updatedAt | ${object.updatedAt} |`);
  return lines.join("\n");
}

export function formatList(title: string, objects: HubSpotObject[], fields: string[]): string {
  if (objects.length === 0) return `No ${title.toLowerCase()} found.`;
  const lines = [`# ${title} (${objects.length})`, ""];
  for (const object of objects) {
    const label = firstPresent(object, fields) ?? object.id;
    const details = fields
      .map((field) => `${field}: ${object.properties?.[field] ?? "-"}`)
      .join(", ");
    lines.push(`- **${label}** _(${object.id})_ - ${details}`);
  }
  return lines.join("\n");
}

function firstPresent(object: HubSpotObject, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = object.properties?.[field];
    if (value) return value;
  }
  return undefined;
}

export function toolError(error: unknown): { content: Array<{ type: "text"; text: string }> } {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}
