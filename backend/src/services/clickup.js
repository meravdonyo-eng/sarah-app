import axios from 'axios';

const BASE = 'https://api.clickup.com/api/v2';

function makeHeaders(token) {
  return { Authorization: token, Accept: 'application/json' };
}

async function request(endpoint, params, token) {
  const response = await axios.get(`${BASE}/${endpoint}`, {
    params,
    headers: makeHeaders(token),
  });
  return response.data;
}

// Priority label mapping
const PRIORITY_LABELS = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
const PRIORITY_IDS    = { urgent: 1, high: 2, normal: 3, low: 4 };

function formatTask(t) {
  return {
    id:          t.id,
    name:        t.name,
    status:      t.status?.status ?? null,
    priority:    PRIORITY_LABELS[t.priority?.id] ?? t.priority?.priority ?? null,
    assignees:   (t.assignees ?? []).map(a => a.username || a.email).filter(Boolean).join(', ') || null,
    due_date:    t.due_date ? new Date(parseInt(t.due_date)).toISOString().split('T')[0] : null,
    list:        t.list?.name ?? null,
    space:       t.space?.name ?? null,
    url:         t.url ?? null,
    description: (t.description || '').slice(0, 300) || null,
  };
}

// --- Tool definitions for Claude ---
export const CLICKUP_TOOLS = [
  {
    name: 'clickup_search_tasks',
    description: `Search for tasks in ClickUp across the workspace.
Filter by text, status, priority, assignee, or due date.
Priority: "urgent" (highest), "high", "normal", "low".
Status values depend on the workspace (e.g. "Open", "In Progress", "In Review", "Done", "Closed").
Always state source: "From ClickUp: N tasks found"`,
    input_schema: {
      type: 'object',
      properties: {
        query:         { type: 'string',  description: 'Text to search across task names and descriptions' },
        status:        { type: 'string',  description: 'Filter by status (e.g. "Open", "In Progress", "Closed")' },
        priority:      { type: 'string',  enum: ['urgent', 'high', 'normal', 'low'], description: 'Filter by priority' },
        due_date_from: { type: 'string',  description: 'Tasks due on or after this date YYYY-MM-DD' },
        due_date_to:   { type: 'string',  description: 'Tasks due on or before this date YYYY-MM-DD' },
        include_closed:{ type: 'boolean', description: 'Include closed/completed tasks (default: false)' },
        max_results:   { type: 'number',  description: 'Max number of results (default: 20, max: 100)' },
      },
    },
  },
  {
    name: 'clickup_get_task',
    description: 'Get full details of a specific ClickUp task by its ID. Use when the user mentions a task ID or ClickUp URL.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ClickUp task ID (alphanumeric, e.g. "86a8k4j0y" or from a clickup.com/t/... URL)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'clickup_list_spaces',
    description: 'List all Spaces in the ClickUp workspace. Use to understand the project structure or narrow a search to a specific area.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/**
 * Get all teams the token has access to. Used during setup to auto-detect team ID.
 * Returns [{ id, name, members_count }].
 */
export async function getClickUpTeams(token) {
  const data = await request('team', {}, token);
  return (data?.teams ?? []).map(t => ({
    id:   t.id,
    name: t.name,
    members_count: t.members?.length ?? 0,
  }));
}

export async function executeClickupTool(toolName, args, creds) {
  const { token, teamId } = creds;

  switch (toolName) {
    case 'clickup_search_tasks': {
      const limit = Math.min(args.max_results ?? 20, 100);
      const params = {
        page:           0,
        limit,
        include_closed: args.include_closed ? true : false,
        subtasks:       true,
      };

      if (args.query)         params.query             = args.query;
      if (args.status)        params['statuses[]']     = args.status;
      if (args.priority)      params['priorities[]']   = PRIORITY_IDS[args.priority] ?? args.priority;
      if (args.due_date_from) params.due_date_gt       = new Date(args.due_date_from).getTime();
      if (args.due_date_to)   params.due_date_lt       = new Date(args.due_date_to).getTime();

      const data = await request(`team/${teamId}/task`, params, token);
      const tasks = (data?.tasks ?? []).map(formatTask);
      return { total: tasks.length, tasks };
    }

    case 'clickup_get_task': {
      const data = await request(`task/${args.task_id}`, {}, token);
      return formatTask(data);
    }

    case 'clickup_list_spaces': {
      const data = await request(`team/${teamId}/space`, { archived: false }, token);
      return (data?.spaces ?? []).map(s => ({
        id:     s.id,
        name:   s.name,
        private: s.private ?? false,
      }));
    }

    default:
      throw new Error(`Unknown ClickUp tool: ${toolName}`);
  }
}
