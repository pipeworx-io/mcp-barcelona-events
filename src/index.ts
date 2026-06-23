interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Barcelona Events MCP.
 *
 * Cultural events & activities in Barcelona, Spain from the city's open-data
 * portal (opendata-ajuntament.barcelona.cat, "agenda-cultural" CKAN datastore).
 * Keyless, ~2,400 distinct upcoming events. The source is denormalised (several
 * rows per event), so we de-duplicate by register_id in SQL. Filter by keyword,
 * district and date window. Content is in Catalan/Spanish.
 */


const SQL_URL = 'https://opendata-ajuntament.barcelona.cat/data/api/3/action/datastore_search_sql';
const RESOURCE_ID = '3abb2414-1ee0-446e-9c25-380e938adb73';
const UA = 'pipeworx-mcp-barcelona-events/1.0 (+https://pipeworx.io)';
const MAX_LIMIT = 50;
const COLS = [
  'register_id', 'name', 'institution_name', 'start_date', 'end_date', 'timetable',
  'addresses_road_name', 'addresses_start_street_number', 'addresses_neighborhood_name',
  'addresses_district_name', 'addresses_zip_code', 'geo_epgs_4326_lat', 'geo_epgs_4326_lon',
  'values_category', 'values_description',
].join(',');

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Find upcoming cultural events & activities in Barcelona, Spain. Filter by keyword, district (e.g. "Eixample", "Ciutat Vella", "Gràcia") and date window. Returns events with venue, district, coordinates and dates. Content is in Catalan/Spanish.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword over title and description, e.g. "música", "exposició", "infantil".' },
        district: { type: 'string', description: 'Filter by district, e.g. "Eixample", "Ciutat Vella", "Gràcia", "Sant Martí".' },
        from: { type: 'string', description: 'Include events ending on/after this date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'Include events starting on/before this date YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max events (1-${MAX_LIMIT}, default 20).` },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const where: string[] = [`end_date >= '${from}'`];
  if (to) where.push(`start_date <= '${to}T23:59:59'`);
  if (typeof args.district === 'string' && args.district.trim()) where.push(`addresses_district_name ILIKE '%${sql(args.district)}%'`);
  if (typeof args.query === 'string' && args.query.trim()) {
    const q = sql(args.query);
    where.push(`(name ILIKE '%${q}%' OR values_description ILIKE '%${q}%')`);
  }
  const clause = where.join(' AND ');
  const limit = clamp(numArg(args.limit, 20), 1, MAX_LIMIT);
  const offset = Math.max(0, numArg(args.offset, 0));

  const total = await count(clause);
  // De-dup the denormalised rows to one per event, then order by date.
  const rows = (await runSql(
    `SELECT * FROM (SELECT DISTINCT ON (register_id) ${COLS} FROM "${RESOURCE_ID}" WHERE ${clause} ORDER BY register_id, _id) sub ORDER BY start_date ASC LIMIT ${limit} OFFSET ${offset}`,
  )) as BcnRow[];

  return {
    city: 'Barcelona',
    country: 'Spain',
    source: 'opendata-ajuntament.barcelona.cat',
    date_from: from,
    date_to: to || null,
    total_matching: total,
    count: rows.length,
    events: rows.map(normalize),
  };
}

async function count(clause: string): Promise<number> {
  try {
    const r = (await runSql(`SELECT COUNT(DISTINCT register_id) AS n FROM "${RESOURCE_ID}" WHERE ${clause}`)) as { n?: string | number }[];
    return Number(r[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function runSql(sqlText: string): Promise<unknown[]> {
  const res = await fetch(`${SQL_URL}?sql=${encodeURIComponent(sqlText)}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { records?: unknown[] }; error?: { message?: string } };
  if (!res.ok || body.success === false) throw new Error(`Barcelona: ${body.error?.message || `HTTP ${res.status}`}`);
  return body.result?.records ?? [];
}

interface BcnRow {
  register_id?: string;
  name?: string;
  institution_name?: string;
  start_date?: string;
  end_date?: string;
  timetable?: string;
  addresses_road_name?: string;
  addresses_start_street_number?: string;
  addresses_neighborhood_name?: string;
  addresses_district_name?: string;
  addresses_zip_code?: string;
  geo_epgs_4326_lat?: string | number;
  geo_epgs_4326_lon?: string | number;
  values_category?: string;
  values_description?: string;
}

function normalize(e: BcnRow): Record<string, unknown> {
  const street = [e.addresses_road_name, e.addresses_start_street_number].filter((p) => p && String(p).trim()).join(' ');
  return {
    id: e.register_id ? e.register_id.replace(/\D/g, "") || undefined : undefined,
    title: e.name,
    category: e.values_category || undefined,
    date_start: fixDate(e.start_date),
    date_end: fixDate(e.end_date) && fixDate(e.end_date) !== fixDate(e.start_date) ? fixDate(e.end_date) : undefined,
    timetable: e.timetable?.trim() || undefined,
    summary: e.values_description ? e.values_description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) : undefined,
    venue: {
      name: e.institution_name || undefined,
      address: [street, e.addresses_zip_code, 'Barcelona'].filter((p) => p && String(p).trim()).join(', ') || undefined,
      neighborhood: e.addresses_neighborhood_name || undefined,
      district: e.addresses_district_name || undefined,
      latitude: numOrUndef(e.geo_epgs_4326_lat),
      longitude: numOrUndef(e.geo_epgs_4326_lon),
    },
  };
}

/** Some records have a typoed year like "0026-07-01" — coerce a sub-100 year to 20xx. */
function fixDate(s?: string): string {
  if (typeof s !== 'string') return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  let y = Number(m[1]);
  if (y < 100) y += 2000;
  return `${y}-${m[2]}-${m[3]}`;
}
/** Escape single quotes for the read-only datastore SQL (SELECT-only endpoint). */
function sql(v: string): string {
  return v.trim().replace(/'/g, "''").replace(/[;\\]/g, '').slice(0, 80);
}
function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000); // approx Barcelona (CEST)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
