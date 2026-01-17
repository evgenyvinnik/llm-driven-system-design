/**
 * Axios HTTP client configuration for API communication.
 * Sets up base URL, credentials, and interceptors for auth and error handling.
 * @module services/api
 */
import axios from 'axios';

/**
 * Pre-configured axios instance for API calls.
 * Includes auth token injection and 401 redirect handling.
 */
const api = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
  },
});

/** Request interceptor to add auth token from localStorage */
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Response interceptor to handle 401 errors by redirecting to login */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
