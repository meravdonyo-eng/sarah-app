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
WARNING: For funnel conversion counts (e.g. "how many users completed sign-up"), prefer mixpanel_funnel — it applies the correct conversion window and matches the Mixpanel dashboard. Using segmentation for funnel steps can produce different numbers (e.g. 31 vs 28) because segmentation counts all users who ever fired the event, while the funnel counts users who completed all steps within the window.
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
          description: 'unique = count distinct users (default, matches dashboard user counts). general = count total event occurrences (use for error frequency, page views).',
        },
        where: { type: 'string', description: 'Filter expression (e.g. \'properties["$os"] == "iOS"\') — must be identical across all calls in the same analysis' },
        on: { type: 'string', description: 'Property to segment by (e.g. \'properties["$os"]\')' },
      },
      required: ['event', 'from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_retention',
    description: 'Query user retention data from Mixpanel. Always counts unique users (users who returned, not event occurrences). Always state: "From Mixpanel: N% retention (unique users)".',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        retention_type: { type: 'string', enum: ['birth', 'compounded'] },
        where: { type: 'string', description: 'Filter expression — must match filters used in related segmentation/funnel calls' },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_funnel',
    description: `Query funnel conversion data from Mixpanel.
IMPORTANT: This is the ONLY tool that matches the Mixpanel dashboard funnel numbers exactly. It counts unique users who completed all funnel steps within the conversion window.
Use for: "how many users completed sign-up / onboarding / checkout / any multi-step flow".
Do NOT use segmentation to count funnel steps — it gives different numbers (no conversion window applied).
Always call mixpanel_list_funnels first to get funnel_id and conversion_window.
Always state: "From Mixpanel: N unique users converted (funnel, unique users)".`,
    input_schema: {
      type: 'object',
      properties: {
        funnel_id: { type: 'number', description: 'Funnel ID from Mixpanel (get from mixpanel_list_funnels)' },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        conversion_window: { type: 'number', description: 'Conversion window in seconds — MUST match the funnel definition (get from mixpanel_list_funnels)' },
        where: { type: 'string', description: 'Filter expression — must match filters used in related segmentation calls' },
        unit: { type: 'string', enum: ['day', 'week', 'month'], description: 'Time unit for the funnel trend' },
      },
      required: ['funnel_id', 'from_date', 'to_date', 'conversion_window'],
    },
  },
  {
    name: 'mixpanel_list_funnels',
    description: 'List all saved funnels in the Mixpanel project, including their IDs, names, and conversion windows. Always call this before mixpanel_funnel to get the correct funnel_id and conversion_window.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mixpanel_list_events',
    description: 'Get all event names in the Mixpanel project (unique events only)',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mixpanel_list_event_properties',
    description: 'List all properties tracked for a specific event. Use this before filtering with "where" to confirm the exact property name and its values.',
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
    // API returns { results: { timezone: "..." } } or array
    const tz = data?.results?.timezone ?? data?.[0]?.timezone ?? null;
    return tz;
  } catch {
    return null;
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
        // Default to 'unique' (distinct users). Claude should explicitly pass
        // type='general' only when counting total event occurrences (errors, page views).
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
        funnel_id: args.funnel_id,
        from_date: args.from_date,
        to_date: args.to_date,
        conversion_window: args.conversion_window,
      };
      if (args.where) params.where = args.where;
      if (args.unit) params.unit = args.unit;
      return request('funnels', params, creds);
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
