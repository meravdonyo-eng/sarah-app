import axios from 'axios';

const BASE = 'https://mixpanel.com/api/2.0';

function authHeader(username, secret) {
  return 'Basic ' + Buffer.from(`${username}:${secret}`).toString('base64');
}

async function request(endpoint, params, creds) {
  const { projectId, username, secret } = creds;
  const response = await axios.get(`${BASE}/${endpoint}`, {
    params: { project_id: projectId, ...params },
    headers: { Authorization: authHeader(username, secret), Accept: 'application/json' },
  });
  return response.data;
}

// --- Tool definitions for Claude ---
export const MIXPANEL_TOOLS = [
  {
    name: 'mixpanel_segmentation',
    description: `Query event counts from Mixpanel over time.
COUNTING MODE — choose carefully:
- type="unique" → counts UNIQUE USERS who triggered the event (default). Use for: "how many users did X", activation, sign-ups, feature adoption.
- type="general" → counts TOTAL EVENT OCCURRENCES. Use for: error frequency, page views, how many times X happened.
WARNING: For funnel conversion counts (e.g. "how many users completed sign-up"), prefer mixpanel_funnel — it applies the correct conversion window and sequence. Using segmentation for funnel steps produces different numbers than the dashboard.
Always state the counting method in your response: "From Mixpanel: N unique users" or "From Mixpanel: N total events".`,
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event name (e.g. "Sign Up")' },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD (required, always explicit)' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD (required, always explicit)' },
        unit: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: 'Time unit' },
        type: {
          type: 'string',
          enum: ['unique', 'general'],
          description: 'unique = count distinct users (default). general = count total event occurrences (use for error frequency, page views).',
        },
        where: { type: 'string', description: 'Filter expression (e.g. \'properties["$os"] == "iOS"\') — must be identical across all calls in the same analysis' },
        on: { type: 'string', description: 'Property to segment by (e.g. \'properties["$os"]\')' },
      },
      required: ['event', 'from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_retention',
    description: 'Query user retention data from Mixpanel. Always counts unique users. Always state: "From Mixpanel: N% retention (unique users)".',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        retention_type: { type: 'string', enum: ['birth', 'compounded'] },
        where: { type: 'string', description: 'Filter expression' },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_funnel',
    description: `Query funnel conversion data from Mixpanel. Always counts UNIQUE USERS in sequence. Matches the Mixpanel dashboard exactly.

TWO MODES — use whichever is easier:

MODE A — Ad-hoc (preferred): provide an events array with the event names in order.
  Example: events=["Sign Up Completed","Onboarding Started","Activated"]
  No funnel_id needed. conversion_window defaults to 7 days.

MODE B — Saved funnel: provide funnel_id from mixpanel_list_funnels.
  Use when the PM refers to a specific saved funnel by name.

ALWAYS use this tool (not segmentation) for questions like:
  "how many went from X to Y", "conversion rate", "drop-off", "how many completed"
Always state: "From Mixpanel funnel: N unique users (X→Y, unique users)"`,
    input_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of event names for an ad-hoc funnel (e.g. ["Sign Up Started","Activated"]). Preferred over funnel_id.',
        },
        funnel_id: {
          type: 'number',
          description: 'ID of a saved Mixpanel funnel (from mixpanel_list_funnels). Use only if PM refers to a specific saved funnel.',
        },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        conversion_window: {
          type: 'number',
          description: 'Days a user has to complete the next step (default: 7). Increase for products with longer cycles.',
        },
        where: { type: 'string', description: 'Filter expression for all steps' },
        unit: { type: 'string', enum: ['day', 'week', 'month'], description: 'Time unit for trend view (omit for aggregate totals)' },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_list_funnels',
    description: 'List all saved funnels in the Mixpanel project, including their IDs, names, and step events.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mixpanel_list_events',
    description: 'Get all event names in the Mixpanel project. Use exact names (case-sensitive) in funnel and segmentation queries.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mixpanel_list_event_properties',
    description: 'List all properties tracked for a specific event. Use before filtering with "where" to confirm the exact property name and values.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event name to get properties for' },
      },
      required: ['event'],
    },
  },
];

/**
 * Fetch the Mixpanel project timezone so date queries match the dashboard.
 * Returns a timezone string like "America/Los_Angeles" or null on failure.
 */
export async function getMixpanelProjectTimezone(creds) {
  try {
    const data = await request('projects', {}, creds);
    const tz = data?.results?.timezone ?? data?.[0]?.timezone ?? null;
    return tz;
  } catch {
    return null;
  }
}

/**
 * Parse the raw Mixpanel /funnels API response into a clean, unambiguous
 * step-by-step breakdown so Claude cannot misread it.
 *
 * Handles two response structures:
 * 1. Saved funnel (funnel_id): data[date].steps[]
 * 2. Ad-hoc funnel (events array): data[date].steps[] — same structure
 *
 * Never sum daily step counts — users converting across date boundaries
 * would be double-counted. Use the first (aggregate) entry only.
 */
function parseFunnelResponse(raw) {
  try {
    const dataEntries = Object.entries(raw?.data ?? {});
    if (dataEntries.length === 0) return raw;

    // Without 'unit', Mixpanel returns one aggregate entry for the full period.
    // With 'unit', it returns per-period entries — we still use the first one
    // as the aggregate (the overall count is in the step.count field, not a sum).
    const [, periodData] = dataEntries[0];
    const rawSteps = periodData?.steps ?? [];
    if (rawSteps.length === 0) return raw;

    const startCount = rawSteps[0]?.count ?? 0;

    const steps = rawSteps.map((s, i) => ({
      step: i + 1,
      event: s.event?.event ?? s.goal ?? `Step ${i + 1}`,
      unique_users: s.count,
      avg_time_days: s.avg_time ? +(s.avg_time / 86400).toFixed(1) : null,
      pct_from_step_1: startCount > 0 ? +((s.count / startCount * 100).toFixed(2)) : 0,
      pct_from_previous_step: i === 0
        ? 100
        : rawSteps[i - 1]?.count > 0
          ? +((s.count / rawSteps[i - 1].count * 100).toFixed(2))
          : 0,
    }));

    return {
      _instruction: 'Parsed funnel results — read unique_users directly. Do NOT call mixpanel_segmentation to verify these numbers.',
      steps,
      overall_conversion_pct: steps.length >= 2
        ? +((steps[steps.length - 1].unique_users / steps[0].unique_users * 100).toFixed(2))
        : 100,
    };
  } catch {
    return raw;
  }
}

export async function executeMixpanelTool(toolName, args, creds) {
  switch (toolName) {
    case 'mixpanel_segmentation': {
      const params = {
        event: args.event,
        from_date: args.from_date,
        to_date: args.to_date,
        unit: args.unit || 'day',
        type: args.type || 'unique',
      };
      if (args.where) params.where = args.where;
      if (args.on) params.on = args.on;
      return request('segmentation', params, creds);
    }

    case 'mixpanel_retention': {
      const params = {
        from_date: args.from_date,
        to_date: args.to_date,
        retention_type: args.retention_type || 'birth',
      };
      if (args.where) params.where = args.where;
      return request('retention', params, creds);
    }

    case 'mixpanel_funnel': {
      const params = {
        from_date: args.from_date,
        to_date: args.to_date,
        type: 'unique', // always unique users — never total events
      };

      if (args.events?.length > 0) {
        // MODE A: Ad-hoc funnel — event names provided directly (preferred).
        // Matches how the official Mixpanel MCP works: no funnel_id required.
        // conversion_window in days (default 7, matching Mixpanel dashboard default).
        params.event = JSON.stringify(args.events.map(e => ({ event: e })));
        params.conversion_window = args.conversion_window ?? 7;
      } else if (args.funnel_id) {
        // MODE B: Saved funnel — use funnel_id from list_funnels.
        params.funnel_id = args.funnel_id;
        if (args.conversion_window) params.conversion_window = args.conversion_window;
      } else {
        throw new Error('mixpanel_funnel requires either events[] or funnel_id');
      }

      if (args.where) params.where = args.where;
      if (args.unit) params.unit = args.unit;

      const raw = await request('funnels', params, creds);
      return parseFunnelResponse(raw);
    }

    case 'mixpanel_list_funnels':
      return request('funnels/list', {}, creds);

    case 'mixpanel_list_events':
      return request('events/names', { type: 'unique' }, creds);

    case 'mixpanel_list_event_properties':
      return request('events/properties', {
        event: args.event,
        type: 'unique',
      }, creds);

    default:
      throw new Error(`Unknown Mixpanel tool: ${toolName}`);
  }
}
