import { useState, useEffect, useRef } from 'react';
import { apiUrl } from '../config';

function AgentConfig() {
  const [prompt, setPrompt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetchPrompt();
  }, []);

  const fetchPrompt = async () => {
    try {
      const res = await fetch(apiUrl('/api/agent'));
      const data = await res.json();
      setPrompt(data.prompt);
    } catch (err) {
      console.error('Failed to fetch agent config:', err);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    try {
      const text = await file.text();
      const res = await fetch(apiUrl('/api/agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text }),
      });

      if (!res.ok) {
        throw new Error('Failed to upload prompt');
      }

      const data = await res.json();
      setPrompt(data.prompt);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleClear = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiUrl('/api/agent'), { method: 'DELETE' });
      if (!res.ok) {
        throw new Error('Failed to clear prompt');
      }
      setPrompt(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const truncatePrompt = (text, maxLength = 100) => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <h2 className="text-sm font-medium text-gray-700">Agent System Prompt</h2>
          <span
            className={`px-2 py-0.5 text-xs rounded-full ${
              prompt ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
            }`}
          >
            {prompt ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div className="flex items-center space-x-2">
          <label className="cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              onChange={handleFileUpload}
              className="hidden"
              disabled={loading}
            />
            <span className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 transition-colors">
              {loading ? 'Loading...' : 'Upload .txt'}
            </span>
          </label>
          {prompt && (
            <button
              onClick={handleClear}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 disabled:bg-gray-100 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {prompt && (
        <div className="bg-gray-50 rounded-md p-3">
          <p className="text-sm text-gray-600 font-mono">{truncatePrompt(prompt)}</p>
        </div>
      )}
    </div>
  );
}

export default AgentConfig;
