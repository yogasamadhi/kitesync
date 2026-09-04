import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { ApiError, api, type AuthSession, type NodeInfo } from './api.js';
import { AuthPage } from './auth-page.js';
import { Dashboard } from './dashboard.js';
import { UnencryptedLanWarning } from './transport-warning.js';
import './styles.css';

function RootShell() {
  return (
    <>
      <UnencryptedLanWarning />
      <Outlet />
    </>
  );
}

const rootRoute = createRootRoute({ component: RootShell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: App });
const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status === 401) && failureCount < 1,
      refetchInterval: 15_000,
      refetchOnWindowFocus: true,
    },
  },
});

const startupOpenToken = takeOpenTokenFromHash();
const initialStatePromise = loadInitialState(startupOpenToken);

interface InitialState {
  setupRequired: boolean;
  session: AuthSession | null;
  node?: NodeInfo;
}

function App() {
  const [setupRequired, setSetupRequired] = useState<boolean>();
  const [node, setNode] = useState<NodeInfo>();
  const [session, setSession] = useState<AuthSession | null>();
  const [startupError, setStartupError] = useState('');

  const forgetAuthentication = useCallback(() => {
    api.clearSession();
    queryClient.clear();
    setNode(undefined);
    setSession(null);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = api.onUnauthorized(forgetAuthentication);
    void initialStatePromise
      .then((initial) => {
        if (!active) return;
        setSetupRequired(initial.setupRequired);
        setSession(initial.session);
        setNode(initial.node);
      })
      .catch((cause: unknown) => {
        if (active) {
          setStartupError(cause instanceof Error ? cause.message : '无法连接到本机节点');
        }
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [forgetAuthentication]);

  useEffect(() => {
    if (!session) return;
    const expiresIn = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
      forgetAuthentication();
      return;
    }
    const timer = window.setTimeout(forgetAuthentication, expiresIn);
    return () => window.clearTimeout(timer);
  }, [forgetAuthentication, session]);

  if (startupError) {
    return (
      <main className="startup-state">
        <span className="brand-mark">K</span>
        <h1>无法连接 KiteSync</h1>
        <p>{startupError}</p>
        <button onClick={() => window.location.reload()}>重新连接</button>
      </main>
    );
  }

  if (setupRequired === undefined || session === undefined) {
    return <div className="loading">正在连接本机 KiteSync…</div>;
  }

  if (!session) {
    return (
      <AuthPage
        setupRequired={setupRequired}
        onAuthenticated={(authenticated) => {
          setSession(authenticated);
          setSetupRequired(false);
          setNode(undefined);
          void api
            .node()
            .then(setNode)
            .catch((cause: unknown) => {
              if (cause instanceof ApiError && cause.status === 401) return;
              setStartupError(cause instanceof Error ? cause.message : '无法读取本机节点状态');
            });
        }}
      />
    );
  }

  if (!node) return <div className="loading">正在读取本机节点状态…</div>;

  return <Dashboard initialNode={node} onLogout={forgetAuthentication} />;
}

async function loadInitialState(openToken: string | null): Promise<InitialState> {
  const status = await api.authStatus();
  if (status.setupRequired) return { setupRequired: true, session: null };

  let session: AuthSession;
  try {
    session = openToken ? await api.loginWithOpenToken({ token: openToken }) : await api.session();
  } catch {
    api.clearSession();
    return { setupRequired: false, session: null };
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    api.clearSession();
    return { setupRequired: false, session: null };
  }

  try {
    return { setupRequired: false, session, node: await api.node() };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      api.clearSession();
      return { setupRequired: false, session: null };
    }
    throw cause;
  }
}

function takeOpenTokenFromHash() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
