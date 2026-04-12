import { useState } from 'react';
import AdminPanel from './components/AdminPanel';

function Login({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'x-admin-token': token },
      });
      if (res.ok) {
        onLogin(token);
      } else {
        setError('Invalid admin token');
      }
    } catch {
      setError('Cannot connect to server');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Sarah Admin</h1>
        <p className="text-gray-500 text-sm mb-6">Enter your admin token to continue</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            placeholder="Admin token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            type="submit"
            className="w-full bg-blue-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-700 transition"
          >
            Login
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [adminToken, setAdminToken] = useState(null);

  if (!adminToken) return <Login onLogin={setAdminToken} />;
  return <AdminPanel adminToken={adminToken} />;
}
