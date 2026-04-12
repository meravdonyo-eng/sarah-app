import { useState, useEffect } from 'react';

const API = (path) => `/api/admin${path}`;

function headers(token) {
  return { 'x-admin-token': token, 'Content-Type': 'application/json' };
}

function StatCard({ label, value, color }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6 flex flex-col gap-1">
      <span className={`text-3xl font-bold ${color}`}>{value}</span>
      <span className="text-gray-500 text-sm">{label}</span>
    </div>
  );
}

function Badge({ connected }) {
  return connected ? (
    <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Connected</span>
  ) : (
    <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">Not connected</span>
  );
}

function PromptEditor({ workspace, adminToken, onSave }) {
  const [prompt, setPrompt] = useState(workspace.system_prompt || '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(API(`/workspaces/${workspace.workspace_id}/prompt`), {
      method: 'POST',
      headers: headers(adminToken),
      body: JSON.stringify({ prompt }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    onSave();
  }

  return (
    <div className="mt-3 space-y-2">
      <textarea
        rows={6}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="System prompt for this workspace (leave empty to use default)"
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
      />
      <button
        onClick={save}
        disabled={saving}
        className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
      >
        {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Prompt'}
      </button>
    </div>
  );
}

function WorkspaceRow({ workspace, adminToken, onRefresh }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 font-bold text-sm">
            {(workspace.team_name || '?')[0].toUpperCase()}
          </div>
          <div>
            <p className="font-medium text-gray-900">{workspace.team_name || 'Unknown Team'}</p>
            <p className="text-xs text-gray-400">{workspace.workspace_id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge connected={workspace.has_mixpanel} /> <span className="text-xs text-gray-400">Mixpanel</span>
          <span className="mx-1 text-gray-200">|</span>
          <Badge connected={workspace.has_jira} /> <span className="text-xs text-gray-400">Jira</span>
          <span className="ml-3 text-gray-400">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-5 py-4">
          <p className="text-xs text-gray-400 mb-2">
            Installed: {new Date(workspace.created_at).toLocaleDateString()}
          </p>
          <p className="text-sm font-medium text-gray-700 mb-1">System Prompt</p>
          <PromptEditor workspace={workspace} adminToken={adminToken} onSave={onRefresh} />
        </div>
      )}
    </div>
  );
}

export default function AdminPanel({ adminToken }) {
  const [stats, setStats] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [statsRes, wsRes] = await Promise.all([
      fetch(API('/stats'), { headers: headers(adminToken) }),
      fetch(API('/workspaces'), { headers: headers(adminToken) }),
    ]);
    setStats(await statsRes.json());
    setWorkspaces(await wsRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const installUrl = `${window.location.origin.replace('5173', '3001')}/api/slack/install`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Sarah Admin</h1>
          <p className="text-xs text-gray-400">Workspace management</p>
        </div>
        <a
          href={installUrl}
          target="_blank"
          rel="noreferrer"
          className="bg-[#4A154B] text-white text-sm px-4 py-2 rounded-lg hover:opacity-90 transition flex items-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 122.8 122.8" fill="white">
            <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" />
            <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" />
            <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" />
            <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" />
          </svg>
          Add to Slack
        </a>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {loading ? (
          <p className="text-gray-400 text-center py-20">Loading…</p>
        ) : (
          <>
            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <StatCard label="Total Workspaces" value={stats?.total_workspaces || 0} color="text-blue-600" />
              <StatCard label="Mixpanel Connected" value={stats?.with_mixpanel || 0} color="text-purple-600" />
              <StatCard label="Jira Connected" value={stats?.with_jira || 0} color="text-blue-400" />
            </div>

            {/* Workspaces */}
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Workspaces</h2>
              {workspaces.length === 0 ? (
                <div className="bg-white rounded-xl shadow-sm p-10 text-center text-gray-400">
                  <p className="text-lg mb-2">No workspaces yet</p>
                  <p className="text-sm">Use "Add to Slack" to install Sarah in a workspace</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {workspaces.map((ws) => (
                    <WorkspaceRow
                      key={ws.workspace_id}
                      workspace={ws}
                      adminToken={adminToken}
                      onRefresh={load}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
