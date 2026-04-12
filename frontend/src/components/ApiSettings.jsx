import { useState, useEffect } from 'react';
import { apiUrl } from '../config';

function ApiSettings() {
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  useEffect(() => {
    if (isOpen && (hasApiKey || process.env.NODE_ENV === 'development')) {
      fetchModels();
    }
  }, [isOpen, hasApiKey]);

  const fetchSettings = async () => {
    try {
      const res = await fetch(apiUrl('/api/settings'), {
        credentials: 'include',
      });
      const data = await res.json();
      setHasApiKey(data.hasApiKey);
      setSelectedModel(data.model || '');
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    }
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    try {
      const res = await fetch(apiUrl('/api/settings/models'), {
        credentials: 'include',
      });
      const data = await res.json();
      if (data.models) {
        setModels(data.models);
      } else if (data.error) {
        setError(data.message);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
    } finally {
      setModelsLoading(false);
    }
  };

  const handleSaveApiKey = async () => {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // First validate the key
      const validateRes = await fetch(apiUrl('/api/settings/validate-key'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ apiKey }),
      });
      const validateData = await validateRes.json();

      if (!validateData.valid) {
        setError(validateData.message);
        setLoading(false);
        return;
      }

      // Save the key
      const res = await fetch(apiUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ apiKey }),
      });

      const data = await res.json();
      setHasApiKey(data.hasApiKey);
      setApiKey(''); // Clear input
      setSuccess('API key saved successfully');
      fetchModels(); // Refresh models list
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveApiKey = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiUrl('/api/settings/api-key'), {
        method: 'DELETE',
        credentials: 'include',
      });

      const data = await res.json();
      setHasApiKey(data.hasApiKey);
      setSuccess('API key removed');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleModelChange = async (e) => {
    const model = e.target.value;
    setSelectedModel(model);
    setError(null);

    try {
      await fetch(apiUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ model }),
      });
      setSuccess('Model updated');
      setTimeout(() => setSuccess(null), 2000);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full"
      >
        <div className="flex items-center space-x-2">
          <svg
            className="w-5 h-5 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          <h2 className="text-sm font-medium text-gray-700">API Settings</h2>
          {hasApiKey && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 text-green-700">
              Custom Key
            </span>
          )}
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="mt-4 space-y-4">
          {error && (
            <div className="p-2 text-sm text-red-600 bg-red-50 rounded">{error}</div>
          )}
          {success && (
            <div className="p-2 text-sm text-green-600 bg-green-50 rounded">{success}</div>
          )}

          {/* API Key Section */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              Anthropic API Key
            </label>
            {hasApiKey ? (
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-500">API key is configured</span>
                <button
                  onClick={handleRemoveApiKey}
                  disabled={loading}
                  className="text-sm text-red-600 hover:text-red-800"
                >
                  Remove
                </button>
              </div>
            ) : (
              <div className="flex space-x-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleSaveApiKey}
                  disabled={loading || !apiKey}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400"
                >
                  {loading ? 'Saving...' : 'Save'}
                </button>
              </div>
            )}
            <p className="mt-1 text-xs text-gray-400">
              Optional. Uses server key if not provided.
            </p>
          </div>

          {/* Model Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">
              Model
            </label>
            {modelsLoading ? (
              <div className="text-sm text-gray-500">Loading models...</div>
            ) : models.length > 0 ? (
              <select
                value={selectedModel}
                onChange={handleModelChange}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Default (Claude Sonnet 4)</option>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-sm text-gray-500">
                {hasApiKey ? 'Failed to load models' : 'Add API key to see available models'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ApiSettings;
