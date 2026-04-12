// API configuration - uses environment variable in production, proxy in development
export const API_URL = import.meta.env.VITE_API_URL || '';

// Helper to build API endpoints
export function apiUrl(path) {
  return `${API_URL}${path}`;
}
