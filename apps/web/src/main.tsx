import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { api, type Session } from './api.js';
import { AuthPage } from './auth-page.js';
import { Dashboard } from './dashboard.js';
import './styles.css';

const rootRoute = createRootRoute({ component: Outlet });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: App,
});
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchInterval: 15_000 } },
});

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void api
      .session()
      .then(setSession)
      .catch(() => setSession(null));
  }, []);
  if (session === undefined) return <div className="loading">正在连接 KiteSync…</div>;
  return session ? (
    <Dashboard session={session} onLogout={() => setSession(null)} />
  ) : (
    <AuthPage onAuthenticated={setSession} />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
