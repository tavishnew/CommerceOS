import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  bootstrapSession,
  getStoredBuyerEmail,
  isDemoAccount,
  DEMO_ACCOUNT_EMAIL,
  type BootstrapResponse,
} from '@/lib/api';

export type BootstrapStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface WorkspaceState {
  /** Server-resolved workspace id. Null until bootstrap completes. */
  workspaceId: string | null;
  /** Server-resolved merchant workspace id (from /api/bootstrap). */
  merchantWorkspaceId: string | null;
  /** Server-resolved email (may be null for anonymous sessions). */
  email: string | null;
  /** True iff the server says this is the demo workspace. Never trust client-set. */
  isDemo: boolean;
  status: BootstrapStatus;
  error: string | null;
  /** Re-runs the bootstrap call. Safe — server is idempotent. */
  retry: () => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

/**
 * Calls /api/bootstrap exactly once per App mount (plus explicit retries).
 * Server is authoritative: browser-supplied isDemo / workspaceId are ignored.
 * The id returned here is what every API call should use.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<WorkspaceState, 'retry'>>({
    workspaceId: null,
    merchantWorkspaceId: null,
    email: null,
    isDemo: false,
    status: 'idle',
    error: null,
  });
  const mountedRef = useRef(true);
  const inflightRef = useRef<Promise<void> | null>(null);

  const run = useCallback(() => {
    if (inflightRef.current) return inflightRef.current;
    setState((s) => ({ ...s, status: 'loading', error: null }));
    const email = getStoredBuyerEmail();
    const p = (async () => {
      try {
        const res: BootstrapResponse = await bootstrapSession(email);
        if (!mountedRef.current) return;
        setState({
          workspaceId: res.workspaceId,
          merchantWorkspaceId: res.merchantWorkspaceId,
          email: res.email,
          isDemo: isDemoAccount(res.email) || res.isDemo,
          status: 'ready',
          error: null,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setState((s) => ({
          ...s,
          status: 'error',
          error: err instanceof Error ? err.message : 'Bootstrap failed',
        }));
      } finally {
        inflightRef.current = null;
      }
    })();
    inflightRef.current = p;
    return p;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void run();
    return () => {
      mountedRef.current = false;
    };
    // run is stable; this effect runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<WorkspaceState>(
    () => ({ ...state, retry: run }),
    [state, run],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  }
  return ctx;
}

/** Returns the server-resolved workspaceId, or null until bootstrap completes.
 *  Callers should treat null as "wait" — never substitute the local fallback
 *  once a bootstrap result is in flight. */
export function useWorkspaceId(): string | null {
  return useWorkspace().workspaceId;
}

export { DEMO_ACCOUNT_EMAIL };
