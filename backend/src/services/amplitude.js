import axios from 'axios';

const BASE = 'https://amplitude.com/api/2';

function authHeader(apiKey, secretKey) {
  return 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
}

/** Convert YYYY-MM-DD → YYYYMMDD (Amplitude date format) */
function toAmplitudeDate(isoDate) {
  return isoDate.replace(/-/g, '');
}

async function request(endpoint, params, creds) {
  const { apiKey, secretKey } = creds;
  const response = await axios.get(`${BASE}/${endpoint}`, {
    params,
    headers: { Authorization: authHeader(apiKey, secretKey), Accept: 'application/json' },
  });
  return response.data;
}

// --- Tool definitions for Claude ---
export const AMPLITUDE_TOOLS = [
  {
    name: 'amplitude_segmentation',
    description: `Query event counts from Amplitude over time.
COUNTING MODE — choose carefully:
- metric="uniques" → counts UNIQUE USERS who triggered the event (default). Use for: "how many users did X", activation, sign-ups, feature adoption.
- metric="totals" → counts TOTAL EVENT OCCURRENCES. Use for: error frequency, page views, how many times X happened.
Always state the counting method in your response: "From Amplitude: N unique users" or "From Amplitude: N total events".`,
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event type name (exact, case-sensitive)' },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD (required)' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD (required)' },
        unit: { type: 'string', enum: ['day', 'week', 'month'], description: 'Time unit (default: day)' },
        metric: {
          type: 'string',
          enum: ['uniques', 'totals'],
          description: 'uniques = unique users (default). totals = total event occurrences (use for error frequency, page views).',
        },
      },
      required: ['event', 'from_date', 'to_date'],
    },
  },
  {
    name: 'amplitude_retention',
    description: 'Query user retention data from Amplitude. Returns cohort retention rates by day.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        starting_event: { type: 'string', description: 'Event that defines a new user cohort (default: "any event")' },
        returning_event: { type: 'string', description: 'Event that counts as "retained" (default: "any event")' },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'amplitude_funnel',
    description: `Query funnel conversion data from Amplitude. Always counts UNIQUE USERS in sequence.

Provide the event names in order to build an ad-hoc funnel:
  Example: events=["Sign Up Completed","Onboarding Started","Activated"]
  conversion_window: days a user has to complete the next step (default: 7).

IMPORTANT: Amplitude has NO saved funnels — always use the events array. There is no funnel_id.
ALWAYS use this tool (not segmentation) for questions like:
  "how many went from X to Y", "conversion rate", "drop-off", "how many completed"
Always state: "From Amplitude funnel: N unique users (X→Y, unique users)"`,
    input_schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of event names (e.g. ["Sign Up Started","Activated"]). Minimum 2 events required.',
        },
        from_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to_date: { type: 'string', description: 'End date YYYY-MM-DD' },
        conversion_window: {
          type: 'number',
          description: 'Days a user has to complete the next step (default: 7)',
        },
      },
      required: ['events', 'from_date', 'to_date'],
    },
  },
  {
    name: 'amplitude_list_events',
    description: 'Get all event type names in the Amplitude project. Use exact names (case-sensitive) in funnel and segmentation queries.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'amplitude_list_event_properties',
    description: 'List all properties tracked for a specific event type. Use before filtering to confirm the exact property name and values.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event type name to get properties for' },
      },
      required: ['event'],
    },
  },
];

export async function executeAmplitudeTool(toolName, args, creds) {
  switch (toolName) {
    case 'amplitude_segmentation': {
      const intervalMap = { day: 1, week: 7, month: 30 };
      const interval = intervalMap[args.unit || 'day'] ?? 1;
      const metric = args.metric === 'totals' ? 'totals' : 'uniques';

      const data = await request('events/segmentation', {
        e: JSON.stringify({ event_type: args.event }),
        start: toAmplitudeDate(args.from_date),
        end: toAmplitudeDate(args.to_date),
        m: metric,
        i: interval,
      }, creds);

      // Normalize to a clean format matching Mixpanel-like output
      const series = data?.data?.series?.[0] ?? [];
      const xValues = data?.data?.xValues ?? [];
      const total = series.reduce((sum, v) => sum + (Number(v) || 0), 0);

      return {
        event: args.event,
        metric,
        from_date: args.from_date,
        to_date: args.to_date,
        total,
        series: xValues.map((date, i) => ({ date, value: series[i] ?? 0 })),
      };
    }

    case 'amplitude_retention': {
      const startingEvent = args.starting_event || 'any event';
      const returningEvent = args.returning_event || 'any event';

      const data = await request('retention', {
        se: JSON.stringify({ event_type: startingEvent }),
        re: JSON.stringify({ event_type: returningEvent }),
        start: toAmplitudeDate(args.from_date),
        end: toAmplitudeDate(args.to_date),
      }, creds);

      const rows = data?.data?.rows ?? [];
      const parsed = rows
        .filter(r => (r.cohortSize ?? 0) > 0)
        .map(row => ({
          cohort_date: row.date ?? null,
          cohort_size: row.cohortSize ?? 0,
          day_1:  row.row?.[1]  ?? null,
          day_7:  row.row?.[7]  ?? null,
          day_14: row.row?.[14] ?? null,
          day_30: row.row?.[30] ?? null,
        }));

      const avgRetention = (key) => {
        const vals = parsed.map(r => r[key]).filter(v => v != null);
        if (vals.length === 0) return null;
        return +((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
      };

      return {
        starting_event: startingEvent,
        returning_event: returningEvent,
        from_date: args.from_date,
        to_date: args.to_date,
        avg_day_1_retention:  avgRetention('day_1'),
        avg_day_7_retention:  avgRetention('day_7'),
        avg_day_14_retention: avgRetention('day_14'),
        avg_day_30_retention: avgRetention('day_30'),
        cohorts: parsed.slice(0, 10),
      };
    }

    case 'amplitude_funnel': {
      if (!Array.isArray(args.events) || args.events.length < 2) {
        throw new Error('amplitude_funnel requires at least 2 events in the events array');
      }

      const conversionWindow = args.conversion_window ?? 7;

      const data = await request('funnels', {
        e: JSON.stringify(args.events.map(e => ({ event_type: e }))),
        start: toAmplitudeDate(args.from_date),
        end: toAmplitudeDate(args.to_date),
        n: conversionWindow,
        mode: 'uniques',
      }, creds);

      const steps = data?.data?.steps ?? [];
      if (steps.length === 0) return data;

      // Sum users across cohort days to get the period total
      const totalUsers = steps.map(s => {
        const arr = Array.isArray(s.users) ? s.users : [s.users ?? 0];
        return arr.reduce((sum, v) => sum + (Number(v) || 0), 0);
      });

      const parsedSteps = totalUsers.map((count, i) => ({
        step: i + 1,
        event: steps[i].event_name ?? args.events[i],
        unique_users: count,
        pct_from_step_1: totalUsers[0] > 0
          ? +((count / totalUsers[0] * 100).toFixed(2)) : 0,
        pct_from_previous_step: i === 0
          ? 100
          : totalUsers[i - 1] > 0
            ? +((count / totalUsers[i - 1] * 100).toFixed(2))
            : 0,
      }));

      return {
        _instruction: 'Parsed funnel results — read unique_users directly. Do NOT call amplitude_segmentation to verify these numbers.',
        steps: parsedSteps,
        overall_conversion_pct: parsedSteps.length >= 2
          ? +((parsedSteps[parsedSteps.length - 1].unique_users / parsedSteps[0].unique_users * 100).toFixed(2))
          : 100,
      };
    }

    case 'amplitude_list_events': {
      const data = await request('taxonomy/event', {}, creds);
      // Return array of event type strings — same format as Mixpanel list_events
      // so IntentMapper and discovery logic works identically
      return (data?.data ?? [])
        .filter(e => !e.deleted)
        .map(e => e.event_type)
        .filter(Boolean);
    }

    case 'amplitude_list_event_properties': {
      const data = await request(
        `taxonomy/event/${encodeURIComponent(args.event)}`,
        {},
        creds,
      );
      return {
        event: args.event,
        properties: (data?.data ?? []).map(p => ({
          property: p.event_property,
          description: p.description || null,
        })),
      };
    }

    default:
      throw new Error(`Unknown Amplitude tool: ${toolName}`);
  }
}
