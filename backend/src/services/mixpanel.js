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
    description: 'Query unique user counts and trends over time from Mixpanel. Always counts unique users, not total event occurrences.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event name (e.g. "Sign Up")' },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD (required, always explicit)' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD (required, always explicit)' },
        unit: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: 'Time unit' },
        where: { type: 'string', description: 'Filter expression (e.g. \'properties["$os"] == "iOS"\') — must be identical across all calls in the same analysis' },
        on: { type: 'string', description: 'Property to segment by (e.g. \'properties["$os"]\')' },
      },
      required: ['event', 'from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_retention',
    description: 'Query user retention data from Mixpanel. Counts unique users.',
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
    description: 'Query funnel conversion data from Mixpanel. Use mixpanel_list_funnels first to get funnel_id and its conversion_window.',
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
];

export async function executeMixpanelTool(toolName, args, creds) {
  switch (toolName) {
    case 'mixpanel_segmentation': {
      const params = {
        event: args.event,
        from_date: args.from_date,
        to_date: args.to_date,
        unit: args.unit || 'day',
        type: 'unique',
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

    default:
      throw new Error(`Unknown Mixpanel tool: ${toolName}`);
  }
}
