import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../config';

function IntegrationStatus() {
  const [status, setStatus] = useState({ servers: [], status: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/mcp/status'), {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to fetch status');
      const data = await res.json();
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();

    // Listen for OAuth completion messages
    const handleMessage = (event) => {
      if (event.data?.type === 'oauth_complete') {
        fetchStatus();
      }
    };
    window.addEventListener('message', handleMessage);

    return () => window.removeEventListener('message', handleMessage);
  }, [fetchStatus]);

  const handleConnect = async (serverId) => {
    try {
      const res = await fetch(apiUrl(`/api/mcp/connect/${serverId}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ region: 'us' }),
      });

      if (!res.ok) throw new Error('Failed to initiate connection');

      const data = await res.json();
      if (data.authUrl) {
        // Open OAuth flow in a popup
        window.open(data.authUrl, 'oauth', 'width=600,height=700');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDisconnect = async (serverId) => {
    try {
      const res = await fetch(apiUrl(`/api/mcp/disconnect/${serverId}`), {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to disconnect');

      fetchStatus();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="mb-4 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="text-gray-500">Loading integrations...</div>
      </div>
    );
  }

  const connectedServers = status.status?.filter((s) => s.connected) || [];
  const disconnectedServers = status.status?.filter((s) => !s.connected) || [];

  return (
    <div className="mb-4 p-4 bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-700">Integrations</h3>
        <button
          onClick={fetchStatus}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-3 text-sm text-red-600 bg-red-50 p-2 rounded">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {connectedServers.map((server) => (
          <div
            key={server.id}
            className="flex items-center gap-2 px-3 py-1.5 bg-green-50 border border-green-200 rounded-full"
          >
            <span className="w-2 h-2 bg-green-500 rounded-full"></span>
            <span className="text-sm text-green-700">{server.name}</span>
            <button
              onClick={() => handleDisconnect(server.id)}
              className="text-green-600 hover:text-green-800 ml-1"
              title="Disconnect"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        ))}

        {disconnectedServers.map((server) => (
          <button
            key={server.id}
            onClick={() => handleConnect(server.id)}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-full hover:bg-gray-100 transition-colors"
          >
            <span className="w-2 h-2 bg-gray-400 rounded-full"></span>
            <span className="text-sm text-gray-600">{server.name}</span>
            <span className="text-xs text-gray-400">Connect</span>
          </button>
        ))}

        {status.status?.length === 0 && (
          <span className="text-sm text-gray-500">No integrations available</span>
        )}
      </div>
    </div>
  );
}

export default IntegrationStatus;
