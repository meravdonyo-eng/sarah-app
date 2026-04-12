import { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../config';

const ADMIN_TOKEN_STORAGE_KEY = 'sarah_admin_token';

function getInitialToken() {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredToken(token) {
  try {
    if (!token) {
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  } catch {
    // ignore
  }
}

async function authedFetch(path, token, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('x-admin-token', token);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
  });

  return res;
}

export default function AdminAgentPrompt() {
  const [adminToken, setAdminToken] = useState(getInitialToken);
  const isAdmin = useMemo(() => !!adminToken, [adminToken]);

  const [showUnlock, setShowUnlock] = useState(false);
  const [unlockToken, setUnlockToken] = useState('');
  const [unlockError, setUnlockError] = useState(null);
  const [unlockLoading, setUnlockLoading] = useState(false);

  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState('');

  const verifyAndUnlock = async (token) => {
    setUnlockLoading(true);
    setUnlockError(null);

    try {
      const res = await authedFetch('/api/agent', token);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `Unauthorized (${res.status})`);
      }

      setAdminToken(token);
      setStoredToken(token);
      setShowUnlock(false);
      setUnlockToken('');

      // Immediately open editor once unlocked
      setShowEditor(true);
    } catch (e) {
      setUnlockError(e.message || 'Failed to unlock admin');
    } finally {
      setUnlockLoading(false);
    }
  };

  const handleAdminEntrance = () => {
    if (isAdmin) {
      setShowEditor(true);
    } else {
      setUnlockError(null);
      setShowUnlock(true);
    }
  };

  const loadPrompt = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await authedFetch('/api/agent', adminToken);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `Failed to load (${res.status})`);
      }
      const data = await res.json();
      setPrompt(data.prompt || '');
    } catch (e) {
      setError(e.message || 'Failed to load prompt');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (showEditor && isAdmin) {
      loadPrompt();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showEditor, isAdmin]);

  const savePrompt = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await authedFetch('/api/agent', adminToken, {
        method: 'POST',
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `Failed to save (${res.status})`);
      }

      const data = await res.json();
      setPrompt(data.prompt || '');
    } catch (e) {
      setError(e.message || 'Failed to save prompt');
    } finally {
      setLoading(false);
    }
  };

  const clearPrompt = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await authedFetch('/api/agent', adminToken, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || `Failed to clear (${res.status})`);
      }
      setPrompt('');
    } catch (e) {
      setError(e.message || 'Failed to clear prompt');
    } finally {
      setLoading(false);
    }
  };

  const lockAdmin = () => {
    setAdminToken('');
    setStoredToken('');
    setShowEditor(false);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={handleAdminEntrance}
          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-md hover:bg-black transition-colors"
        >
          Admin
        </button>
        {isAdmin && (
          <button
            onClick={lockAdmin}
            className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition-colors"
          >
            Lock
          </button>
        )}
      </div>

      {showUnlock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white shadow-lg border border-gray-200">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Unlock Admin</h2>
              <p className="text-sm text-gray-600 mt-1">
                Enter your admin password to edit the Agent System Prompt.
              </p>
            </div>

            <div className="p-4 space-y-3">
              <input
                type="password"
                value={unlockToken}
                onChange={(e) => setUnlockToken(e.target.value)}
                placeholder="Admin password"
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                autoFocus
              />

              {unlockError && <p className="text-sm text-red-600">{unlockError}</p>}

              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setShowUnlock(false)}
                  className="px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
                  disabled={unlockLoading}
                >
                  Cancel
                </button>
                <button
                  onClick={() => verifyAndUnlock(unlockToken)}
                  className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                  disabled={unlockLoading || !unlockToken}
                >
                  {unlockLoading ? 'Unlocking…' : 'Unlock'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-3xl rounded-lg bg-white shadow-lg border border-gray-200">
            <div className="p-4 border-b border-gray-200 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Agent System Prompt</h2>
                <p className="text-sm text-gray-600 mt-1">
                  This prompt is stored server-side and is hidden from regular viewers.
                </p>
              </div>
              <button
                onClick={() => setShowEditor(false)}
                className="px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300"
              >
                Close
              </button>
            </div>

            <div className="p-4 space-y-3">
              {error && <p className="text-sm text-red-600">{error}</p>}

              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Type your system prompt here…"
                className="w-full h-64 px-3 py-2 border border-gray-300 rounded-md font-mono text-sm"
              />

              <div className="flex items-center justify-between">
                <button
                  onClick={clearPrompt}
                  className="px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 disabled:bg-gray-100"
                  disabled={loading}
                >
                  Clear
                </button>

                <div className="flex items-center gap-2">
                  <button
                    onClick={loadPrompt}
                    className="px-3 py-2 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 disabled:bg-gray-100"
                    disabled={loading}
                  >
                    Reload
                  </button>
                  <button
                    onClick={savePrompt}
                    className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                    disabled={loading}
                  >
                    {loading ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
