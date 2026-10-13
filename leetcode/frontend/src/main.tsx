import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { RootLayout } from './components/RootLayout';
import { HomePage } from './pages/HomePage';
import { ProblemsPage } from './pages/ProblemsPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ProgressPage } from './pages/ProgressPage';
import './index.css';

// The problem workspace (CodeMirror + markdown) and the admin dashboard are separate chunks,
// so the catalog and login pages don't download the editor.
const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'problems', element: <ProblemsPage /> },
      {
        path: 'problems/:slug',
        lazy: () => import('./pages/ProblemPage').then((module) => ({ Component: module.ProblemPage })),
      },
      { path: 'login', element: <LoginPage /> },
      { path: 'register', element: <RegisterPage /> },
      { path: 'progress', element: <ProgressPage /> },
      {
        path: 'admin',
        lazy: () => import('./pages/AdminPage').then((module) => ({ Component: module.AdminPage })),
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);
