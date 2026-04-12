/**
 * Direct Mixpanel API Integration (No OAuth Required)
 *
 * This is an alternative to using Mixpanel's MCP server with OAuth.
 * Instead, it uses Mixpanel's REST API directly with API credentials.
 *
 * Setup:
 * 1. Get your Mixpanel credentials:
 *    - Project ID (from project settings)
 *    - Service Account Username and Secret (from project settings > Service Accounts)
 * 2. Add to your .env file:
 *    MIXPANEL_PROJECT_ID=your-project-id
 *    MIXPANEL_SERVICE_ACCOUNT_USERNAME=your-username
 *    MIXPANEL_SERVICE_ACCOUNT_SECRET=your-secret
 */

import fetch from 'node-fetch';

const MIXPANEL_API_BASE = 'https://mixpanel.com/api';
const MIXPANEL_API_VERSION = '2.0';

/**
 * Get Mixpanel credentials from environment
 */
function getMixpanelCredentials() {
  const projectId = process.env.MIXPANEL_PROJECT_ID;
  const username = process.env.MIXPANEL_SERVICE_ACCOUNT_USERNAME;
  const secret = process.env.MIXPANEL_SERVICE_ACCOUNT_SECRET;

  if (!projectId || !username || !secret) {
    throw new Error(
      'Mixpanel credentials not configured. Set MIXPANEL_PROJECT_ID, ' +
      'MIXPANEL_SERVICE_ACCOUNT_USERNAME, and MIXPANEL_SERVICE_ACCOUNT_SECRET'
    );
  }

  return { projectId, username, secret };
}

/**
 * Make an authenticated request to Mixpanel API
 */
async function mixpanelRequest(endpoint, params = {}) {
  const { username, secret } = getMixpanelCredentials();

  // Create Basic Auth header
  const auth = Buffer.from(`${username}:${secret}`).toString('base64');

  // Build query string
  const queryParams = new URLSearchParams(params);
  const url = `${MIXPANEL_API_BASE}/${MIXPANEL_API_VERSION}/${endpoint}?${queryParams}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Mixpanel API error: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * Query Mixpanel Segmentation
 *
 * Example usage:
 * const result = await querySegmentation('Page View', {
 *   from_date: '2024-01-01',
 *   to_date: '2024-01-31',
 *   type: 'general',
 * });
 */
export async function querySegmentation(event, params = {}) {
  const { projectId } = getMixpanelCredentials();

  return mixpanelRequest('segmentation', {
    project_id: projectId,
    event,
    ...params,
  });
}

/**
 * Query Mixpanel Funnels
 *
 * Example usage:
 * const result = await queryFunnel(12345, {
 *   from_date: '2024-01-01',
 *   to_date: '2024-01-31',
 * });
 */
export async function queryFunnel(funnelId, params = {}) {
  const { projectId } = getMixpanelCredentials();

  return mixpanelRequest('funnels', {
    project_id: projectId,
    funnel_id: funnelId,
    ...params,
  });
}

/**
 * Query Mixpanel Retention
 */
export async function queryRetention(params = {}) {
  const { projectId } = getMixpanelCredentials();

  return mixpanelRequest('retention', {
    project_id: projectId,
    ...params,
  });
}

/**
 * Get list of events in a project
 */
export async function listEvents(params = {}) {
  const { projectId } = getMixpanelCredentials();

  return mixpanelRequest('events/names', {
    project_id: projectId,
    ...params,
  });
}

/**
 * Get list of event properties
 */
export async function listEventProperties(event, params = {}) {
  const { projectId } = getMixpanelCredentials();

  return mixpanelRequest('events/properties', {
    project_id: projectId,
    event,
    ...params,
  });
}

/**
 * Export tools for Claude to use
 */
export const MIXPANEL_TOOLS = [
  {
    name: 'mixpanel_segmentation',
    description: 'Query Mixpanel segmentation data to analyze event counts and trends over time',
    input_schema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          description: 'The event name to query (e.g., "Page View", "Sign Up")',
        },
        from_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        unit: {
          type: 'string',
          description: 'Time unit: hour, day, week, month',
          enum: ['hour', 'day', 'week', 'month'],
        },
      },
      required: ['event', 'from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_retention',
    description: 'Query Mixpanel retention data to analyze user retention over time',
    input_schema: {
      type: 'object',
      properties: {
        from_date: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to_date: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        retention_type: {
          type: 'string',
          description: 'Type of retention: birth or compounded',
          enum: ['birth', 'compounded'],
        },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'mixpanel_list_events',
    description: 'Get a list of all event names in the Mixpanel project',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Event type: general or all',
          enum: ['general', 'all'],
        },
      },
    },
  },
  {
    name: 'mixpanel_list_event_properties',
    description: 'Get a list of properties for a specific event',
    input_schema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          description: 'The event name',
        },
      },
      required: ['event'],
    },
  },
];

/**
 * Execute a Mixpanel tool call
 */
export async function executeMixpanelTool(toolName, args) {
  switch (toolName) {
    case 'mixpanel_segmentation':
      return querySegmentation(args.event, {
        from_date: args.from_date,
        to_date: args.to_date,
        unit: args.unit || 'day',
        type: 'general',
      });

    case 'mixpanel_retention':
      return queryRetention({
        from_date: args.from_date,
        to_date: args.to_date,
        retention_type: args.retention_type || 'birth',
      });

    case 'mixpanel_list_events':
      return listEvents({ type: args.type || 'general' });

    case 'mixpanel_list_event_properties':
      return listEventProperties(args.event);

    default:
      throw new Error(`Unknown Mixpanel tool: ${toolName}`);
  }
}
