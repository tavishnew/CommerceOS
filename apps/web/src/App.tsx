import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  Copy,
  CreditCard,
  FileKey2,
  FileSearch,
  FileText,
  Filter,
  Globe2,
  KeyRound,
  LayoutGrid,
  LockKeyhole,
  Menu,
  Moon,
  MoreHorizontal,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  Terminal,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  X,
  Zap,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Link, Route, Switch, useLocation } from 'wouter';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { ApiError, NetworkUnreachableError } from '@/lib/api';

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (response: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }) => void;
  modal?: {
    ondismiss?: () => void;
  };
  prefill?: Record<string, string>;
  theme?: { color?: string };
}

interface RazorpayInstance {
  open: () => void;
  close: () => void;
}
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import NotFound from '@/pages/not-found';
import { cn } from '@/lib/utils';
import { WorkspaceProvider, useWorkspace } from '@/hooks/use-workspace';
import {
  type Product,
  type Order,
  type TraceStep,
  type BuyerQueryResult,
  type MerchantSettings,
  type CreateOrderResponse,
  type RazorpaySettings,
  type RazorpayTestResult,
  fetchCatalog,
  fetchOrders,
  fetchOrder,
  updateProduct,
  deleteProduct,
  submitBuyerQuery,
  acceptUpsell,
  type UpsellAcceptResponse,
  fetchSettings,
  updateSettings,
  createRazorpayOrder,
  verifyOrder,
  createOrder,
  fetchAudit,
  exportAudit,
  type AuditRow,
  type AuditResponse,
  fetchDebugStatus,
  toggleDebugFailure,
  type DebugStatus,
  fetchRazorpaySettings,
  saveRazorpaySettings,
  testRazorpaySettings,
  disputeOrder,
  refundOrder,
  getOrCreateBuyerWorkspaceId,
  setStoredBuyerEmail,
  createBasket,
  startCheckout,
  humanApproveCheckout,
  fetchBuyerSession,
  updateBuyerSession,
  fetchBuyerOrders,
  fetchActivity,
  type ActivityRow,
  fetchTransactionDetail,
  type BuyerSession,
  type Basket,
  type CheckoutStartResponse,
  type CheckoutStartPolicy,
  type TransactionDetail,
} from '@/lib/api';

const queryClient = new QueryClient();

type Theme = 'light' | 'dark';
type Role = 'merchant' | 'buyer';

const navMerchant = [
  { href: '/merchant', label: 'Overview', icon: LayoutGrid },
  { href: '/merchant/catalog', label: 'Catalog', icon: Package },
  { href: '/merchant/orders', label: 'Orders', icon: ShoppingBag },
  { href: '/merchant/activity', label: 'Agent Activity', icon: Radio },
  { href: '/merchant/audit', label: 'Audit Log', icon: FileText },
];

const navBuyer = [
  { href: '/buyer', label: 'Agent Console', icon: Bot },
  { href: '/buyer/trace', label: 'Decision Trace', icon: Activity },
  { href: '/buyer/checkout', label: 'Test Checkout', icon: CreditCard },
  { href: '/buyer/orders', label: 'Order History', icon: Package },
  { href: '/buyer/settings', label: 'Settings', icon: SettingsIcon },
];

function outcomeColor(o: string): string {
  if (o === 'success' || o === 'auto_approved' || o === 'approved' || o === 'recovered')
    return 'text-positive';
  if (o === 'failed' || o === 'degraded' || o === 'human_approval_required')
    return 'text-warning';
  return 'text-muted-foreground';
}

function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-3" data-testid="link-logo">
      <span
        className={cn(
          'grid h-8 w-8 place-items-center rounded-[9px] border',
          inverse
            ? 'border-[var(--commerce-border-strong)] bg-[var(--commerce-signal)] text-[var(--commerce-signal-foreground)]'
            : 'border-foreground/20 bg-foreground text-background',
        )}
      >
        <span className="font-display text-[17px] font-bold leading-none">0</span>
      </span>
      <span
        className={cn(
          'font-display text-[20px] font-bold tracking-[-.04em]',
          inverse ? 'text-sidebar-foreground' : 'text-foreground',
        )}
      >
        Commerce<span className="text-[var(--commerce-signal)]">0S</span>
      </span>
    </Link>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === 'dark';
  return (
    <button
      onClick={onToggle}
      className="group relative grid h-9 w-9 place-items-center rounded-full border border-foreground/15 bg-background text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
      data-testid="button-theme-toggle"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function Pill({ children, signal = false }: { children: ReactNode; signal?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[10px] uppercase tracking-[.12em]',
        signal
          ? 'border-[var(--commerce-signal)]/35 bg-[var(--commerce-signal)]/10 text-[var(--commerce-signal-strong)]'
          : 'border-foreground/15 bg-foreground/[.04] text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function ButtonArrow({
  children,
  onClick,
  variant = 'primary',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'outline' | 'ghost';
  testId?: string;
}) {
  return (
    <Button
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'group h-11 rounded-full px-5 text-sm font-semibold transition-all',
        variant === 'primary' && 'bg-foreground text-background hover:bg-foreground/85',
        variant === 'outline' &&
          'border border-foreground/20 bg-transparent text-foreground hover:bg-foreground/[.06]',
        variant === 'ghost' && 'bg-transparent px-3 text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      <ArrowRight size={15} className="ml-2 transition-transform group-hover:translate-x-1" />
    </Button>
  );
}

function Landing({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [, setLocation] = useLocation();
  const { isDemo } = useWorkspace();
  const { data: liveRows = [] } = useQuery<ActivityRow[]>({
    queryKey: ['activity', 'landing', isDemo],
    queryFn: () => fetchActivity(4, undefined, isDemo),
    refetchInterval: 4000,
  });
  return (
    <div className="grain min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <header className="relative z-10 mx-auto flex max-w-[1240px] items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Logo />
        <nav className="hidden items-center gap-8 text-[13px] font-semibold text-muted-foreground md:flex">
          <a href="#protocol" className="transition hover:text-foreground">
            Protocol
          </a>
          <a href="#operators" className="transition hover:text-foreground">
            Operators
          </a>
          <a href="#trust" className="transition hover:text-foreground">
            Trust layer
          </a>
        </nav>
        <div className="flex items-center gap-2.5">
          <ThemeToggle theme={theme} onToggle={onToggle} />
          <Button
            onClick={() => setLocation('/auth')}
            data-testid="button-open-console"
            className="hidden h-9 rounded-full bg-foreground px-4 text-xs font-bold text-background hover:bg-foreground/85 sm:inline-flex"
          >
            Open console
          </Button>
          <button
            className="grid h-9 w-9 place-items-center rounded-full border border-foreground/15 md:hidden"
            data-testid="button-mobile-menu"
          >
            <Menu size={16} />
          </button>
        </div>
      </header>

      <main>
        <section className="relative mx-auto max-w-[1240px] px-5 pb-20 pt-16 sm:px-8 sm:pt-24 lg:px-10 lg:pb-32 lg:pt-28">
          <div
            className="absolute -right-20 top-16 h-[420px] w-[420px] rounded-full blur-3xl"
            style={{ background: 'color-mix(in oklab, var(--commerce-signal) 10%, transparent)' }}
          />
          <div className="relative grid items-center gap-12 lg:grid-cols-[1.02fr_.98fr] lg:gap-16">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.65 }}
              className="relative max-w-[800px]"
            >
              <Pill signal>
                <span
                  className="h-1.5 w-1.5 rounded-full status-live"
                  style={{ background: 'var(--commerce-signal)' }}
                />{' '}
                Protocol online · test mode
              </Pill>
              <h1 className="mt-7 max-w-[820px] font-display text-[clamp(3.8rem,8vw,7.8rem)] font-bold leading-[.88] tracking-[-.075em] text-[var(--commerce-ink)]">
                Commerce,
                <br />
                <span className="text-[var(--commerce-signal)]">
                  with agency.
                </span>
              </h1>
              <p className="mt-8 max-w-[525px] text-[17px] leading-7 text-muted-foreground sm:text-[19px]">
                The operating surface for a new kind of marketplace — where buyer and seller agents
                discover, decide, transact, and explain themselves.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <ButtonArrow onClick={() => setLocation('/auth')} testId="button-start-building">
                  Start building
                </ButtonArrow>
                <ButtonArrow
                  onClick={() =>
                    document.getElementById('protocol')?.scrollIntoView({ behavior: 'smooth' })
                  }
                  variant="outline"
                  testId="button-see-protocol"
                >
                  See the protocol
                </ButtonArrow>
              </div>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, x: 28, rotate: 3 }}
              animate={{ opacity: 1, x: 0, rotate: 0 }}
              transition={{ duration: 0.8, delay: 0.25 }}
              className="hero-console relative mx-auto w-full max-w-[470px] lg:mt-10"
              aria-label="Live agent decision preview"
            >
              <div className="hero-console-glow absolute -inset-8 rounded-[38px] blur-3xl" />
              <div className="relative overflow-hidden rounded-[26px] border border-[var(--commerce-border)] bg-[var(--commerce-surface-raised)]/90 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-[var(--commerce-border)] px-5 py-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--commerce-signal-foreground)]"
                      style={{ background: 'var(--commerce-signal)' }}
                    >
                      <Bot size={16} />
                    </span>
                    <div>
                      <p className="text-xs font-bold">Northstar / buyer agent</p>
                      <p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[var(--commerce-text-muted)]">
                        decision stream · live
                      </p>
                    </div>
                  </div>
                  <Pill signal>
                    <span
                      className="h-1.5 w-1.5 rounded-full status-live"
                      style={{ background: 'var(--commerce-signal)' }}
                    />{' '}
                    online
                  </Pill>
                </div>
                <div className="space-y-4 p-5">
                  <div className="rounded-xl bg-[var(--commerce-surface-sunken)] p-4">
                    <p className="font-mono-ui text-[9px] uppercase tracking-[.13em] text-[var(--commerce-text-muted)]">
                      incoming intent
                    </p>
                    <p className="mt-2 text-sm font-semibold">Find a warm task light under $180.</p>
                  </div>
                  <div className="space-y-3 pl-3">
                    {[
                      ['01', 'Intent parsed', '4 constraints extracted'],
                      ['02', 'Catalog searched', '24 candidates returned'],
                      ['03', 'Policy verified', 'ceiling · delivery · trust'],
                    ].map(([num, title, detail], i) => (
                      <motion.div
                        key={num}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.65 + i * 0.16 }}
                        className="relative flex gap-3 pl-4"
                        style={{ borderLeft: '2px solid color-mix(in oklab, var(--commerce-signal) 55%, transparent)' }}
                      >
                        <span
                          className="font-mono-ui text-[10px]"
                          style={{ color: 'var(--commerce-signal-strong)' }}
                        >
                          {num}
                        </span>
                        <div>
                          <p className="text-xs font-semibold">{title}</p>
                          <p className="mt-0.5 font-mono-ui text-[9px] text-[var(--commerce-text-muted)]">
                            {detail}
                          </p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                  <div
                    className="flex items-center justify-between rounded-xl border p-4"
                    style={{
                      borderColor: 'color-mix(in oklab, var(--commerce-signal) 50%, transparent)',
                      background: 'color-mix(in oklab, var(--commerce-signal) 10%, transparent)',
                    }}
                  >
                    <div>
                      <p className="font-mono-ui text-[9px] uppercase tracking-[.13em] text-[var(--commerce-text-muted)]">
                        recommendation
                      </p>
                      <p className="mt-1 text-sm font-bold">Lattice Desk Lamp</p>
                    </div>
                    <span className="font-display text-xl font-bold">$148</span>
                  </div>
                </div>
                <div className="flex items-center justify-between border-t border-[var(--commerce-border)] px-5 py-3 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[var(--commerce-text-muted)]">
                  <span>trace_8f31c0a9</span>
                  <span className="text-[var(--commerce-signal-strong)]">explainable</span>
                </div>
              </div>
            </motion.div>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 30, rotate: -2 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="network-stage relative mt-20 h-[310px] overflow-hidden rounded-[28px] border border-[var(--commerce-border)] bg-[var(--commerce-surface-sunken)] sm:h-[390px] lg:mt-24"
            aria-label="Live Commerce0S agent network map"
          >
            <div className="absolute left-5 top-5 flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.14em] text-[var(--commerce-text-muted)]">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: 'var(--commerce-signal)' }}
              />{' '}
              live network map <span className="ml-2 opacity-40">/ 04 nodes</span>
            </div>
            <div className="wireframe absolute inset-0 grid place-items-center [perspective:1200px]">
              <div
                className="network-aurora absolute -left-16 top-10 h-56 w-56 rounded-full blur-3xl"
                style={{ background: 'color-mix(in oklab, var(--commerce-signal) 20%, transparent)' }}
              />
              <div
                className="network-aurora network-aurora-delay absolute -right-16 bottom-0 h-64 w-64 rounded-full blur-3xl"
                style={{ background: 'color-mix(in oklab, var(--commerce-signal) 14%, transparent)' }}
              />
              <div className="wireframe-grid absolute h-[500px] w-[950px] rounded-[50%] opacity-70 [transform:rotateX(64deg)_rotateZ(-8deg)_translateY(40px)]" />
              <svg
                className="network-lines absolute inset-0 h-full w-full opacity-70"
                viewBox="0 0 1000 390"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path d="M185 112 C350 110 390 190 500 195 C630 200 720 120 850 125" />
                <path d="M270 295 C370 240 400 210 500 195 C620 180 665 250 770 295" />
                <path d="M185 112 C230 205 245 245 270 295" />
                <path d="M850 125 C810 190 790 240 770 295" />
              </svg>
              <div className="network-particle particle-one" />
              <div className="network-particle particle-two" />
              <div className="network-particle particle-three" />
              <div className="relative z-10 grid place-items-center [transform:translateZ(60px)]">
                <div
                  className="network-orbit network-orbit-wide absolute h-[220px] w-[420px] rounded-[50%]"
                  style={{ border: '1px solid color-mix(in oklab, var(--commerce-signal) 35%, transparent)' }}
                />
                <div
                  className="network-orbit absolute h-[180px] w-[260px] rounded-[50%]"
                  style={{ border: '1px solid color-mix(in oklab, var(--commerce-signal) 55%, transparent)' }}
                />
                <div
                  className="absolute h-[210px] w-[210px] rounded-full animate-pulse"
                  style={{ border: '1px solid color-mix(in oklab, var(--commerce-signal) 35%, transparent)' }}
                />
                <div
                  className="absolute h-[120px] w-[120px] rounded-full"
                  style={{ border: '1px solid color-mix(in oklab, var(--commerce-signal) 60%, transparent)' }}
                />
                <div
                  className="network-core grid h-20 w-20 place-items-center rounded-2xl"
                  style={{
                    border: '1px solid color-mix(in oklab, var(--commerce-signal) 60%, transparent)',
                    background: 'color-mix(in oklab, var(--commerce-signal) 18%, transparent)',
                    boxShadow: '0 0 80px color-mix(in oklab, var(--commerce-signal) 28%, transparent)',
                  }}
                >
                  <Command size={28} style={{ color: 'var(--commerce-signal)' }} />
                </div>
                <span
                  className="absolute top-[92px] whitespace-nowrap font-mono-ui text-[10px] uppercase tracking-[.16em]"
                  style={{ color: 'var(--commerce-signal)' }}
                >
                  routing intelligence
                </span>
              </div>
              {[
                ['buyer.northstar', 'top-[22%] left-[15%]', 'text-[var(--commerce-signal)]'],
                ['seller.almond', 'right-[12%] top-[28%]', 'text-[var(--commerce-text-muted)]'],
                ['policy.guard', 'bottom-[24%] left-[24%]', 'text-[var(--commerce-text-muted)]/70'],
                ['ledger.test', 'bottom-[17%] right-[19%]', 'text-[var(--commerce-text-muted)]/55'],
              ].map(([name, pos, color], i) => (
                <motion.div
                  key={name}
                  animate={{ y: [0, i % 2 ? -7 : 7, 0] }}
                  transition={{ duration: 3 + i, repeat: Infinity, ease: 'easeInOut' }}
                  className={cn(
                    'absolute flex items-center gap-2 rounded-full border border-foreground/15 bg-background/85 px-3 py-2 font-mono-ui text-[10px] shadow-lg backdrop-blur',
                    pos,
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full bg-current', color)} />
                  {name}
                </motion.div>
              ))}
              <div className="scanline absolute left-[10%] right-[10%] top-[49%] h-px opacity-40" />
            </div>
            <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
              <span>agents negotiate in public</span>
              <span>latency 42ms · encrypted</span>
            </div>
          </motion.div>
        </section>

        <section id="protocol" className="border-y border-foreground/10 bg-foreground/[.025]">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[.75fr_1.25fr] lg:px-10 lg:py-28">
            <div>
              <Pill>01 / Protocol</Pill>
              <h2 className="mt-6 max-w-[440px] font-display text-4xl font-bold leading-[.98] tracking-[-.05em] sm:text-6xl">
                The invisible layer becomes legible.
              </h2>
              <p className="mt-6 max-w-[360px] text-sm leading-6 text-muted-foreground">
                Commerce0S gives every decision a receipt. Not a black box. A protocol trail your
                team, your customer, and your auditors can read.
              </p>
            </div>
            <div className="grid gap-px overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/10 sm:grid-cols-3">
              {(
                [
                  {
                    num: '01',
                    title: 'Discover',
                    text: 'Agents search intent, not catalogs.',
                    Icon: Search,
                  },
                  {
                    num: '02',
                    title: 'Decide',
                    text: 'Policy gates every recommendation.',
                    Icon: ShieldCheck,
                  },
                  {
                    num: '03',
                    title: 'Settle',
                    text: 'Test-mode payments leave proof.',
                    Icon: FileKey2,
                  },
                ] as Array<{ num: string; title: string; text: string; Icon: typeof Search }>
              ).map(({ num, title, text, Icon }) => (
                <div key={num} className="bg-background p-6 sm:p-7">
                  <span className="font-mono-ui text-[10px] text-foreground">
                    {num}
                  </span>
                  <Icon className="mt-12 text-muted-foreground" size={19} />
                  <h3 className="mt-5 font-display text-2xl font-bold">{title}</h3>
                  <p className="mt-2 text-sm leading-5 text-muted-foreground">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          id="operators"
          className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:px-10 lg:py-32"
        >
          <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-end">
            <div>
              <Pill>02 / Operator surface</Pill>
              <h2 className="mt-6 max-w-[700px] font-display text-4xl font-bold leading-[.95] tracking-[-.06em] sm:text-6xl">
                Run the network.
                <br />
                <span className="text-muted-foreground">See every signal.</span>
              </h2>
            </div>
            <p className="max-w-[280px] text-sm leading-6 text-muted-foreground">
              One console for your catalog, orders, agent activity, and the decisions in between.
            </p>
          </div>
          <div className="mt-14 grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
            <div className="relative min-h-[370px] overflow-hidden rounded-3xl border border-[var(--commerce-border-strong)] bg-[var(--commerce-surface-sunken)] p-7 text-[var(--commerce-ink)]">
              <div className="relative">
                <div className="flex items-center justify-between border-b border-[var(--commerce-border)] pb-4 font-mono-ui text-[10px] uppercase tracking-[.14em]">
                  <span className="text-[var(--commerce-text-muted)]">agent activity / now</span>
                  <span className="text-[var(--commerce-signal)]">● recording</span>
                </div>
                <div className="mt-7 space-y-5">
                  {liveRows.length === 0 && (
                    <p className="font-mono-ui text-[11px] text-[var(--commerce-text-muted)]">
                      No protocol events yet. Run a buyer query to populate the trail.
                    </p>
                  )}
                  {liveRows.map((a, i) => (
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: i * 0.12 }}
                      key={a.id}
                      className="flex gap-3 border-l border-[var(--commerce-border)] pl-4"
                    >
                      <span className="font-mono-ui text-[10px] text-[var(--commerce-text-muted)]">
                        {new Date(a.timestamp).toLocaleTimeString()}
                      </span>
                      <div>
                        <p className="font-mono-ui text-xs text-[var(--commerce-text)]">
                          {a.detail ?? a.action}
                        </p>
                        <p className="mt-1 font-mono-ui text-[10px] text-[var(--commerce-text-muted)]">
                          {a.actor} · {a.action}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex min-h-[370px] flex-col justify-between rounded-3xl border border-foreground/15 bg-[var(--commerce-signal)] p-7 text-[var(--commerce-signal-foreground)]">
              <div>
                <div className="flex items-center justify-between">
                  <Bot size={23} />
                  <span className="font-mono-ui text-[10px] uppercase tracking-[.14em]">
                    buyer agent
                  </span>
                </div>
                <p className="mt-20 font-display text-4xl font-bold leading-[.95] tracking-[-.05em]">
                  "Find me
                  <br />
                  something
                  <br />
                  quiet."
                </p>
              </div>
              <div className="flex items-center justify-between border-t border-foreground/20 pt-4 font-mono-ui text-[10px] uppercase">
                <span>4 constraints resolved</span>
                <ArrowUpRight size={15} />
              </div>
            </div>
          </div>
        </section>

        <section
          id="trust"
          className="border-y border-foreground/10 bg-[var(--commerce-signal)] text-[var(--commerce-signal-foreground)]"
        >
          <div className="mx-auto grid max-w-[1240px] gap-14 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_.9fr] lg:px-10 lg:py-28">
            <div>
              <Pill>03 / Trust layer</Pill>
              <h2 className="mt-6 max-w-[600px] font-display text-5xl font-bold leading-[.9] tracking-[-.06em] sm:text-7xl">
                Every "why" has a shape.
              </h2>
            </div>
            <div className="self-end">
              <p className="max-w-[420px] text-sm leading-6 opacity-75">
                Policy boundaries. Evidence chains. Payment states. Commerce0S turns agent autonomy
                into something you can confidently hand the keys to.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">
                  TRACED INTENT
                </span>
                <span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">
                  POLICY-GATED
                </span>
                <span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">
                  EXPLAINABLE
                </span>
              </div>
            </div>
          </div>
        </section>

        <footer className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-12 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10">
          <Logo />
          <div className="flex items-center gap-5 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
            <span>Built for the agent economy</span>
            <button
              onClick={() => setLocation('/auth')}
              className="text-foreground underline underline-offset-4"
              data-testid="button-footer-console"
            >
              Enter console
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
}

function Auth({
  onChooseRole,
  theme,
  onToggle,
}: {
  onChooseRole: (role: Role) => void;
  theme: Theme;
  onToggle: () => void;
}) {
  const { retry: retryBootstrap } = useWorkspace();
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [role, setRole] = useState<Role>('merchant');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  return (
    <div className="grain flex min-h-[100dvh] flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Logo />
        <div className="flex items-center gap-3">
          <span className="hidden font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:inline">
            secure access
          </span>
          <ThemeToggle theme={theme} onToggle={onToggle} />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-12 px-5 py-12 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:gap-24">
        <div className="hidden lg:block">
          <Pill signal>Commerce0S / identity</Pill>
          <h1 className="mt-7 font-display text-7xl font-bold leading-[.88] tracking-[-.07em]">
            Choose your
            <br />
            <span className="text-muted-foreground">vantage point.</span>
          </h1>
          <p className="mt-7 max-w-[360px] text-sm leading-6 text-muted-foreground">
            Your role shapes the console. Switch sides anytime — the protocol stays shared.
          </p>
          <div className="mt-12 flex gap-3 font-mono-ui text-[10px] text-muted-foreground">
            <span>01 / role</span>
            <span className="text-foreground">02 / workspace</span>
            <span>03 / go</span>
          </div>
        </div>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto w-full max-w-[480px] rounded-3xl border border-foreground/15 bg-card p-6 shadow-2xl sm:p-9"
        >
          <div className="flex gap-1 rounded-xl bg-muted p-1">
            <button
              onClick={() => setMode('create')}
              className={cn(
                'flex-1 rounded-lg py-2.5 text-sm font-semibold transition',
                mode === 'create' && 'bg-background shadow-sm',
              )}
              data-testid="button-auth-signup"
            >
              Create workspace
            </button>
            <button
              onClick={() => setMode('signin')}
              className={cn(
                'flex-1 rounded-lg py-2.5 text-sm font-semibold transition',
                mode === 'signin' && 'bg-background shadow-sm',
              )}
              data-testid="button-auth-signin"
            >
              Sign in
            </button>
          </div>
          <div className="mt-8">
            <span className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">
              I am operating as
            </span>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => setRole('merchant')}
                className={cn(
                  'rounded-xl border p-4 text-left transition',
                  role === 'merchant'
                    ? 'border-[var(--commerce-signal)] bg-[var(--commerce-signal)]/10'
                    : 'border-foreground/15 hover:border-foreground/30',
                )}
                data-testid="button-role-merchant"
              >
                <Package size={18} />
                <strong className="mt-3 block text-sm">Merchant</strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Put products in motion.
                </span>
              </button>
              <button
                onClick={() => setRole('buyer')}
                className={cn(
                  'rounded-xl border p-4 text-left transition',
                  role === 'buyer'
                    ? 'border-[var(--commerce-signal)] bg-[var(--commerce-signal)]/10'
                    : 'border-foreground/15 hover:border-foreground/30',
                )}
                data-testid="button-role-buyer"
              >
                <Bot size={18} />
                <strong className="mt-3 block text-sm">Buyer agent</strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Buy within your policy.
                </span>
              </button>
            </div>
          </div>
          <label className="mt-6 block text-xs font-semibold">
            Email address
            <input
              className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-[var(--commerce-signal)]"
              placeholder="you@company.com"
              data-testid="input-auth-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              autoComplete="email"
            />
          </label>
          {mode === 'create' && (
            <label className="mt-4 block text-xs font-semibold">
              Workspace name
              <input
                className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-[var(--commerce-signal)]"
                placeholder="Studio or team name"
                data-testid="input-workspace-name"
              />
            </label>
          )}
          <Button
            onClick={() => {
              setSubmitted(true);
              // Persist the email and clear any stale workspace id so the
              // next bootstrap call mints a fresh candidate workspace for
              // the new email. Without this, the email entered here was
              // dropped on the floor and the user kept landing on the
              // previous (or demo) workspace — which is what surfaced as
              // "demo data after creating a new workspace".
              setStoredBuyerEmail(email.trim() ? email.trim() : null);
              try {
                localStorage.removeItem('commerce0s.buyerWorkspaceId');
                localStorage.removeItem('commerce0s.buyerBootstrapped');
              } catch {
                /* localStorage unavailable */
              }
              void (async () => {
                try {
                  await retryBootstrap();
                } catch {
                  /* surfaced via BootstrapErrorBridge */
                }
                setTimeout(() => onChooseRole(role), 200);
              })();
            }}
            className="mt-6 h-11 w-full rounded-lg bg-foreground text-background hover:bg-foreground/85"
            data-testid="button-auth-submit"
          >
            {submitted
              ? 'Opening workspace…'
              : mode === 'create'
                ? `Continue as ${role === 'merchant' ? 'merchant' : 'buyer'}`
                : 'Enter workspace'}
            <ArrowRight size={15} className="ml-2" />
          </Button>
          <div className="mt-5 flex items-center justify-center gap-2 text-center font-mono-ui text-[10px] text-muted-foreground">
            <LockKeyhole size={12} /> test environment · no real charges
          </div>
        </motion.div>
      </main>
    </div>
  );
}

function Sidebar({
  role,
  page,
  collapsed,
  onCollapse,
  onToggle,
}: {
  role: Role;
  page: string;
  collapsed: boolean;
  onCollapse: () => void;
  onToggle: () => void;
}) {
  const nav = role === 'merchant' ? navMerchant : navBuyer;
  return (
    <aside
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all lg:flex',
        collapsed ? 'w-[76px]' : 'w-[252px]',
      )}
    >
      <div className="flex h-[76px] items-center border-b border-sidebar-border px-5">
        {collapsed ? (
          <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[var(--commerce-signal)] font-display font-bold text-[var(--commerce-signal-foreground)]">
            0
          </span>
        ) : (
          <Logo inverse />
        )}
      </div>
      <div className="flex flex-1 flex-col px-3 py-6">
        <div
          className={cn(
            'mb-4 flex items-center px-3 font-mono-ui text-[9px] uppercase tracking-[.16em] text-sidebar-foreground/40',
            collapsed && 'justify-center px-0',
          )}
        >
          <span>
            {collapsed ? '·' : role === 'merchant' ? 'Operator console' : 'Buyer console'}
          </span>
        </div>
        {nav.map(({ href, label, icon: Icon }) => {
          const active =
            page === href || (href !== '/merchant' && href !== '/buyer' && page.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                'group mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
                collapsed && 'justify-center px-0',
              )}
              data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}
            >
              <Icon size={17} strokeWidth={active ? 2.2 : 1.8} />
              <span className={cn(collapsed && 'hidden')}>{label}</span>
              {active && !collapsed && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--commerce-signal)]" />
              )}
            </Link>
          );
        })}
      </div>
      <div className={cn('border-t border-sidebar-border p-4', collapsed && 'px-3')}>
        <div className={cn('flex items-center gap-3', collapsed && 'justify-center')}>
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-bold">
            {role === 'merchant' ? 'AS' : 'NK'}
          </div>
          <div className={cn('min-w-0', collapsed && 'hidden')}>
            <p className="truncate text-xs font-bold">
              {role === 'merchant' ? 'Almond Studio' : 'Northstar Agent'}
            </p>
            <p className="mt-0.5 truncate font-mono-ui text-[9px] text-sidebar-foreground/45">
              {role === 'merchant' ? 'merchant_01' : 'buyer_09'}
            </p>
          </div>
        </div>
      </div>
      <button
        onClick={onCollapse}
        className="absolute -right-3 top-[84px] grid h-6 w-6 place-items-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground"
        data-testid="button-collapse-sidebar"
      >
        {collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>
    </aside>
  );
}

function Topbar({
  role,
  theme,
  onToggle,
  onMobileMenu,
}: {
  role: Role;
  theme: Theme;
  onToggle: () => void;
  onMobileMenu: () => void;
}) {
  const [, setLocation] = useLocation();
  return (
    <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-foreground/10 bg-background/90 px-4 backdrop-blur-xl sm:px-7">
      <div className="flex items-center gap-3">
        <button
          onClick={onMobileMenu}
          className="grid h-9 w-9 place-items-center rounded-lg border border-foreground/15 lg:hidden"
          aria-label="Open navigation menu"
          data-testid="button-open-mobile-nav"
        >
          <Menu size={17} aria-hidden="true" />
        </button>
        <div className="hidden items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:flex">
          <span className="text-foreground">
            {role === 'merchant' ? 'Almond Studio' : 'Northstar Agent'}
          </span>
          <ChevronRight size={12} />
          <span>Test environment</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[.03] px-3 py-2 font-mono-ui text-[10px] text-muted-foreground md:flex">
          <Search size={13} />
          <span>Search</span>
          <kbd className="ml-3 rounded border border-foreground/15 px-1.5 py-0.5 text-[9px]">
            ⌘ K
          </kbd>
        </div>
        <button
          onClick={() => setLocation('/auth')}
          className="hidden h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted-foreground hover:bg-foreground/[.05] hover:text-foreground sm:flex"
          data-testid="button-switch-role"
        >
          <RefreshCw size={14} /> Switch role
        </button>
        <ThemeToggle theme={theme} onToggle={onToggle} />
      </div>
    </header>
  );
}

function MobileNav({ role, open, onClose }: { role: Role; open: boolean; onClose: () => void }) {
  const nav = role === 'merchant' ? navMerchant : navBuyer;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-foreground/30 lg:hidden"
          onClick={onClose}
        >
          <motion.div
            initial={{ x: -260 }}
            animate={{ x: 0 }}
            exit={{ x: -260 }}
            onClick={(e) => e.stopPropagation()}
            className="h-full w-[270px] bg-sidebar p-5 text-sidebar-foreground"
          >
            <div className="flex items-center justify-between">
              <Logo inverse />
              <button
                onClick={onClose}
                className="text-sidebar-foreground/60"
                data-testid="button-close-mobile-nav"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mt-10 space-y-1">
              {nav.map(({ href, label, icon: Icon }) => (
                <Link
                  href={href}
                  onClick={onClose}
                  key={href}
                  className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent"
                  data-testid={`mobile-link-${label.toLowerCase().replaceAll(' ', '-')}`}
                >
                  <Icon size={17} />
                  {label}
                </Link>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function MetricCard({
  label,
  value,
  delta,
  icon: Icon,
  signal = false,
}: {
  label: string;
  value: string;
  delta: string;
  icon: typeof Activity;
  signal?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-5',
        signal
          ? 'border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10'
          : 'border-foreground/10 bg-card',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
          {label}
        </span>
        <Icon
          size={16}
          className={
            signal
              ? 'text-foreground'
              : 'text-muted-foreground'
          }
        />
      </div>
      <div className="mt-6 flex items-end justify-between gap-3">
        <strong className="font-display text-3xl font-bold tracking-[-.06em]">{value}</strong>
        <span
          className={cn(
            'font-mono-ui text-[10px]',
            signal
              ? 'text-foreground'
              : 'text-muted-foreground',
          )}
        >
          {delta}
        </span>
      </div>
    </div>
  );
}

function MerchantOverview() {
  const [, setLocation] = useLocation();
  const { data: rp } = useQuery<RazorpaySettings>({
    queryKey: ['razorpay-settings'],
    queryFn: fetchRazorpaySettings,
    staleTime: 60_000,
  });
  const showBanner = rp && rp.configured === false;
  return (
    <div className="space-y-7">
      {showBanner && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning/40 bg-warning/5 px-4 py-3 sm:px-5"
          data-testid="banner-payment-not-configured"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 text-warning" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                Payment gateway not configured
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Checkout will fail until you add Razorpay test keys in Settings.
              </p>
            </div>
          </div>
          <Button
            onClick={() => setLocation('/merchant/settings#payment-gateway')}
            variant="outline"
            className="h-9 rounded-full border-warning/40 px-4 text-xs font-semibold text-warning hover:bg-warning/10"
            data-testid="button-banner-open-settings"
          >
            Open settings
          </Button>
        </div>
      )}
      <PageHeading
        eyebrow="Overview / network health"
        title="Good afternoon, Alex."
        description="Your commerce surface is quiet, healthy, and listening."
        action={
          <ButtonArrow
            testId="button-view-catalog"
            onClick={() => setLocation('/merchant/catalog')}
          >
            Manage catalog
          </ButtonArrow>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <p className="col-span-full -mb-1 text-right text-[10px] uppercase tracking-[.12em] text-muted-foreground">
          Sample data — not live
        </p>
        <MetricCard
          label="Gross volume"
          value="$18,426"
          delta="+12.8% / 30d"
          icon={TrendingUp}
          signal
        />
        <MetricCard label="Agent sessions" value="1,284" delta="+18.4%" icon={Users} />
        <MetricCard label="Conversion" value="6.7%" delta="+1.2 pts" icon={ArrowUpRight} />
        <MetricCard label="Avg. decision" value="42ms" delta="-8ms" icon={Zap} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <ActivityPanel />
        <div className="rounded-2xl border border-foreground/10 bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                Decision mix
              </p>
              <h3 className="mt-2 font-display text-xl font-bold">This month · sample data</h3>
            </div>
            <MoreHorizontal size={17} className="text-muted-foreground" />
          </div>
          <div className="mt-8 space-y-5">
            {[
              ['Auto-approved', '72%', 'bg-[var(--commerce-signal)]'],
              ['Human review', '19%', 'bg-[var(--commerce-text-muted)]'],
              ['Declined', '9%', 'bg-[var(--commerce-text-muted)]/55'],
            ].map(([label, value, color]) => (
              <div key={label}>
                <div className="flex justify-between text-xs">
                  <span>{label}</span>
                  <span className="font-mono-ui text-muted-foreground">{value}</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', color)} style={{ width: value }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-9 rounded-xl bg-muted/70 p-3 font-mono-ui text-[10px] leading-5 text-muted-foreground">
            <span className="text-foreground">policy.guard</span> is holding 3 orders for a human
            check.
          </div>
        </div>
      </div>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        <p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">
          {eyebrow}
        </p>
        <h1 className="mt-3 font-display text-4xl font-bold leading-none tracking-[-.06em] sm:text-5xl">
          {title}
        </h1>
        {description && (
          <p className="mt-3 max-w-[560px] text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function ActivityPanel() {
  const [, setLocation] = useLocation();
  const { isDemo } = useWorkspace();
  const { data: rows = [], isLoading, isError, dataUpdatedAt } = useQuery<ActivityRow[]>({
    queryKey: ['activity', 'overview', isDemo],
    queryFn: () => fetchActivity(6, undefined, isDemo),
    refetchInterval: 3000,
  });

  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
            Live protocol trail
          </p>
          <h3 className="mt-2 font-display text-xl font-bold">Agent activity</h3>
        </div>
        <Pill signal={!isError && !isLoading}>
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> {isError ? 'offline' : isLoading ? 'loading' : 'live'}
        </Pill>
      </div>
      <div className="mt-7 space-y-1" data-testid="activity-list">
        {isLoading && rows.length === 0 && (
          <div className="grid place-items-center py-8">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        )}
        {isError && (
          <p className="py-6 text-sm text-muted-foreground">
            Couldn't reach the activity feed. Pull to retry.
          </p>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">
            No activity yet. Run a buyer query to populate the trail.
          </p>
        )}
        {rows.map((a, i) => (
          <div
            key={a.id}
            className="group flex items-start gap-3 rounded-xl px-2 py-3 transition hover:bg-muted/60"
            data-testid={`activity-row-${i}`}
          >
            <span
              className={cn(
                'mt-1 h-2 w-2 shrink-0 rounded-full',
                a.outcome === 'failed' || a.outcome === 'degraded'
                  ? 'bg-warning'
                  : 'bg-positive',
              )}
            />
            <span className="w-[62px] shrink-0 font-mono-ui text-[10px] text-muted-foreground">
              {new Date(a.timestamp).toLocaleTimeString()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{a.detail ?? a.action}</p>
              <p className={cn('mt-1 font-mono-ui text-[9px] uppercase tracking-[.08em]', outcomeColor(a.outcome))}>
                {a.actor} <span className="text-muted-foreground">· {a.action}</span>
              </p>
            </div>
            {a.actor && (
              <ChevronRight
                size={14}
                className="mt-1 text-muted-foreground opacity-0 transition group-hover:opacity-100"
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between px-2">
        <span className="font-mono-ui text-[9px] text-muted-foreground">
          {dataUpdatedAt ? `refreshed ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
        </span>
        <button
          onClick={() => setLocation('/merchant/activity')}
          className="flex items-center gap-1 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground hover:text-foreground"
          data-testid="button-view-all-activity"
        >
          View full activity <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Catalog (wired to real API) ─────────────────────────────────────────────

function Catalog() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'draft' | 'out_of_stock' | 'archived'>(
    'all',
  );
  const [modal, setModal] = useState<Product | 'new' | null>(null);

  const {
    data: products = [],
    isLoading,
    error,
  } = useQuery<Product[]>({
    queryKey: ['catalog'],
    queryFn: fetchCatalog,
    retry: 1,
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog'] }),
  });

  // Map raw product → canonical display status so the UI doesn't lie about
  // stock or archive state. Backend uses availability + inventory_quantity;
  // anything in 'archived' is hidden from agents.
  const displayStatus = (p: Product) => {
    if (p.status === 'archived') return 'archived' as const;
    if (!p.inStock || p.quantity <= 0) return 'out_of_stock' as const;
    if (p.status === 'draft') return 'draft' as const;
    return 'active' as const;
  };

  const visible = products
    .map((p) => ({ p, ds: displayStatus(p) }))
    .filter(({ ds }) => filter === 'all' || ds === filter)
    .filter(({ p }) => `${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Merchant / catalog"
        title="Your catalog, agent-ready."
        description="Products are structured for discovery, priced for policy, and ready to be found."
        action={
          <ButtonArrow onClick={() => setModal('new')} testId="button-add-product">
            <Plus size={15} /> Add product
          </ButtonArrow>
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-[340px] flex-1">
          <Search size={15} className="absolute left-3 top-3 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products or SKU"
            className="h-10 rounded-lg border-foreground/15 bg-card pl-9 text-sm"
            data-testid="input-catalog-search"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-foreground/10 bg-card p-1">
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['draft', 'Draft'],
              ['out_of_stock', 'Out'],
              ['archived', 'Archived'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={cn(
                'rounded-md px-3 py-1.5 font-mono-ui text-[10px] uppercase tracking-[.1em]',
                filter === key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`button-filter-${key}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card">
        <div className="hidden grid-cols-[1.4fr_1fr_.7fr_.6fr_.3fr] border-b border-foreground/10 bg-muted/50 px-5 py-3 font-mono-ui text-[9px] uppercase tracking-[.14em] text-muted-foreground sm:grid">
          <span>Product</span>
          <span>SKU</span>
          <span>Price</span>
          <span>Status</span>
          <span />
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="grid place-items-center px-6 py-20 text-center">
            <Loader2 size={26} className="text-muted-foreground animate-spin" />
            <p className="mt-4 font-display text-xl font-bold">Loading catalog…</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Connecting to the product database.
            </p>
          </div>
        )}

        {/* Error state */}
        {!isLoading && error && (
          <div className="grid place-items-center px-6 py-20 text-center">
            <AlertTriangle size={26} className="text-destructive" />
            <p className="mt-4 font-display text-xl font-bold">Could not load catalog</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Make sure the API server is running on localhost:5000.
            </p>
            <p className="mt-1 font-mono-ui text-[10px] text-destructive">
              {(error as Error).message}
            </p>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && !error && visible.length === 0 && products.length === 0 && (
          <div className="grid place-items-center px-6 py-20 text-center">
            <Box size={26} className="text-muted-foreground" />
            <p className="mt-4 font-display text-xl font-bold">No products yet — add one</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Your catalog is empty. Add your first product to get started.
            </p>
          </div>
        )}

        {/* No search results */}
        {!isLoading && !error && visible.length === 0 && products.length > 0 && (
          <div className="grid place-items-center px-6 py-20 text-center">
            <Box size={26} className="text-muted-foreground" />
            <p className="mt-4 font-display text-xl font-bold">No products found</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Try another search or add a product to your catalog.
            </p>
          </div>
        )}

        {/* Product rows */}
        {!isLoading &&
          !error &&
          visible.map(({ p, ds }) => (
            <div
              key={p.id}
              className="grid gap-3 border-b border-foreground/10 px-5 py-4 last:border-0 sm:grid-cols-[1.4fr_1fr_.7fr_.6fr_.3fr] sm:items-center"
              data-testid={`row-product-${p.id}`}
            >
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-muted">
                  <Package size={16} className="text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{p.name}</p>
                  <p className="font-mono-ui text-[10px] text-muted-foreground">
                    stock {p.quantity}
                  </p>
                </div>
              </div>
              <span className="font-mono-ui text-[11px] text-muted-foreground">{p.sku}</span>
              <span className="text-sm font-semibold">₹{p.price.toFixed(2)}</span>
              <span>
                <Pill
                  signal={ds === 'active'}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {ds === 'out_of_stock' ? 'Out' : ds.charAt(0).toUpperCase() + ds.slice(1)}
                </Pill>
              </span>
              <button
                onClick={() => setModal(p)}
                className="justify-self-end text-muted-foreground hover:text-foreground"
                data-testid={`button-edit-product-${p.id}`}
              >
                <Pencil size={15} />
              </button>
            </div>
          ))}
      </div>

      {modal && (
        <ProductModal product={modal === 'new' ? null : modal} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

// ── ProductModal (wired to real API) ────────────────────────────────────────

function ProductModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [price, setPrice] = useState(product ? String(product.price) : '');
  const [stock, setStock] = useState(String(product?.quantity ?? 1));
  const [status, setStatus] = useState<'active' | 'draft' | 'archived'>(
    product?.status === 'archived'
      ? 'archived'
      : product?.status === 'draft'
        ? 'draft'
        : 'active',
  );
  const [schema, setSchema] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'sku' | 'price' | 'stock';
    message: string;
  } | null>(null);

  const handleSave = async () => {
    // Inline field validation: missing required fields stay close to the field.
    if (!name.trim()) {
      setFieldError({ field: 'name', message: 'Product name is required.' });
      return;
    }
    if (!sku.trim()) {
      setFieldError({ field: 'sku', message: 'SKU is required.' });
      return;
    }
    const parsedPrice = parseFloat(price.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      setFieldError({ field: 'price', message: 'Price must be greater than 0.' });
      return;
    }
    const parsedStock = Number(stock);
    if (!Number.isFinite(parsedStock) || parsedStock < 0) {
      setFieldError({ field: 'stock', message: 'Stock must be 0 or more.' });
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        price: parsedPrice,
        quantity: parsedStock,
        status,
      };

      if (product) {
        await updateProduct(product.id, payload);
      } else {
        const { createProduct } = await import('@/lib/api');
        await createProduct(payload);
      }

      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast({
        title: product ? 'Product updated' : 'Product added',
        description: `${payload.name} is now in the catalog.`,
      });
      onClose();
    } catch (err) {
      console.error('Save failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't save product. Check your connection and try again.";
      toast({
        variant: 'destructive',
        title: product ? "Couldn't update product" : "Couldn't add product",
        description: message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!product) return;
    setDeleting(true);
    try {
      await deleteProduct(product.id);
      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      toast({
        title: 'Product deleted',
        description: `${product.name} was removed from the catalog.`,
      });
      onClose();
    } catch (err) {
      console.error('Delete failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't delete product. Check your connection and try again.";
      toast({
        variant: 'destructive',
        title: "Couldn't delete product",
        description: message,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-foreground/35 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-[520px] rounded-2xl border border-foreground/15 bg-card p-6 shadow-2xl sm:p-8"
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono-ui text-[10px] uppercase tracking-[.13em] text-muted-foreground">
              Catalog / {product ? 'edit product' : 'new product'}
            </p>
            <h2 className="mt-2 font-display text-2xl font-bold">
              {product ? 'Tune product identity' : 'Add to the network'}
            </h2>
          </div>
          <button onClick={onClose} data-testid="button-close-product-modal">
            <X size={18} />
          </button>
        </div>
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <label className="text-xs font-semibold sm:col-span-2">
            Product name
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (fieldError?.field === 'name') setFieldError(null);
              }}
              className={cn(
                'mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-[var(--commerce-signal)]',
                fieldError?.field === 'name' ? 'border-destructive' : 'border-input',
              )}
              data-testid="input-product-name"
            />
            {fieldError?.field === 'name' && (
              <span
                className="mt-1 block text-[11px] text-destructive"
                data-testid="error-product-name"
              >
                {fieldError.message}
              </span>
            )}
          </label>
          <label className="text-xs font-semibold">
            SKU
            <input
              value={sku}
              onChange={(e) => {
                setSku(e.target.value);
                if (fieldError?.field === 'sku') setFieldError(null);
              }}
              className={cn(
                'mt-2 h-10 w-full rounded-lg border bg-background px-3 font-mono-ui text-xs outline-none focus:border-[var(--commerce-signal)]',
                fieldError?.field === 'sku' ? 'border-destructive' : 'border-input',
              )}
              data-testid="input-product-sku"
            />
            {fieldError?.field === 'sku' && (
              <span
                className="mt-1 block text-[11px] text-destructive"
                data-testid="error-product-sku"
              >
                {fieldError.message}
              </span>
            )}
          </label>
          <label className="text-xs font-semibold">
            Price
            <input
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                if (fieldError?.field === 'price') setFieldError(null);
              }}
              className={cn(
                'mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-[var(--commerce-signal)]',
                fieldError?.field === 'price' ? 'border-destructive' : 'border-input',
              )}
              data-testid="input-product-price"
            />
            {fieldError?.field === 'price' && (
              <span
                className="mt-1 block text-[11px] text-destructive"
                data-testid="error-product-price"
              >
                {fieldError.message}
              </span>
            )}
          </label>
          <label className="text-xs font-semibold">
            Units in stock
            <input
              value={stock}
              onChange={(e) => {
                setStock(e.target.value);
                if (fieldError?.field === 'stock') setFieldError(null);
              }}
              type="number"
              className={cn(
                'mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-[var(--commerce-signal)]',
                fieldError?.field === 'stock' ? 'border-destructive' : 'border-input',
              )}
              data-testid="input-product-stock"
            />
            {fieldError?.field === 'stock' && (
              <span
                className="mt-1 block text-[11px] text-destructive"
                data-testid="error-product-stock"
              >
                {fieldError.message}
              </span>
            )}
          </label>
          <label className="text-xs font-semibold">
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'draft' | 'archived')}
              className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-[var(--commerce-signal)]"
              data-testid="select-product-status"
            >
              <option value="active">Active — visible to agents</option>
              <option value="draft">Draft — hidden from agents</option>
              <option value="archived">Archived — removed from agents</option>
            </select>
          </label>
          <div className="flex items-end">
            <button
              onClick={() => setSchema((v) => !v)}
              className="flex h-10 items-center gap-2 rounded-lg border border-foreground/15 px-3 text-xs font-semibold hover:bg-muted"
              data-testid="button-preview-schema"
            >
              <Code2 size={14} /> {schema ? 'Hide schema' : 'Preview schema'}
            </button>
          </div>
        </div>
        {schema && (
          <pre className="mt-5 overflow-auto rounded-xl bg-[var(--commerce-surface-sunken)] p-4 font-mono-ui text-[10px] leading-5 text-[var(--commerce-ink)]">{`{\n  "type": "product",\n  "name": "${name || '…'}",\n  "sku": "${sku || '…'}",\n  "price": { "amount": "${price || '…'}", "currency": "INR" },\n  "availability": ${Number(stock || 0) > 0},\n  "status": "${status}"\n}`}</pre>
        )}
        <div className="mt-7 flex items-center justify-between gap-3">
          {product ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex items-center gap-2 text-xs font-semibold text-destructive hover:underline disabled:opacity-50"
              data-testid="button-delete-product"
            >
              <Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button
              onClick={onClose}
              variant="outline"
              className="rounded-lg"
              data-testid="button-cancel-product"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-foreground text-background disabled:opacity-70"
              data-testid="button-save-product"
            >
              <Check size={15} className="mr-2" /> {saving ? 'Saving…' : 'Save product'}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── Orders (wired to real API) ──────────────────────────────────────────────

function OrderRow({
  order,
  onAction,
  onSelect,
}: {
  order: Order;
  onAction: () => void;
  onSelect?: () => void;
}) {
  const { toast } = useToast();
  const [disputing, setDisputing] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const formatAmount = (n: number) => `₹${n.toFixed(2)}`;
  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs}h ago`;
    return d.toLocaleDateString();
  };

  const handleDispute = async () => {
    const reason = window.prompt('Why is this order being disputed? (short reason, max 500 chars)');
    if (!reason) return;
    setDisputing(true);
    try {
      await disputeOrder(order.id, reason.trim().slice(0, 500), getOrCreateBuyerWorkspaceId());
      toast({ title: 'Dispute opened', description: `Order #${order.id} flagged for review.` });
      onAction();
    } catch (err) {
      console.error('dispute failed:', err);
      const message =
        err instanceof ApiError ? err.message : "Couldn't open the dispute. Try again.";
      toast({ variant: 'destructive', title: "Couldn't dispute order", description: message });
    } finally {
      setDisputing(false);
    }
  };

  const handleRefund = async () => {
    if (
      !window.confirm(
        `Refund ₹${order.amount.toFixed(2)} for order #${order.id}? This calls Razorpay immediately.`,
      )
    )
      return;
    setRefunding(true);
    try {
      const res = await refundOrder(order.id, order.workspace_id ?? 'default');
      toast({ title: 'Refund processed', description: `Razorpay refund ${res.refundId}.` });
      onAction();
    } catch (err) {
      console.error('refund failed:', err);
      const message =
        err instanceof ApiError ? err.message : "Couldn't process the refund. Try again.";
      toast({ variant: 'destructive', title: "Couldn't refund", description: message });
    } finally {
      setRefunding(false);
    }
  };

  const showFlag = order.status === 'paid' || order.status === 'shipped';
  const showRefund =
    order.status === 'paid' || order.status === 'disputed' || order.status === 'shipped';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-4 rounded-xl border border-foreground/10 bg-card p-4 text-left sm:flex-row sm:items-center sm:justify-between sm:px-5',
        onSelect && 'hover:border-[var(--commerce-signal)]/50 hover:bg-muted/30',
      )}
      data-testid={`order-row-${order.id}`}
    >
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">
          <ShoppingBag size={16} className="text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-semibold">
            {order.product_name ?? `Product #${order.product_id}`}
          </p>
          <p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">
            ord_{String(order.id).padStart(4, '0')} · {order.buyer_agent_id}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
        <div className="text-left sm:text-right">
          <p className="text-sm font-semibold">{formatAmount(order.amount)}</p>
          <p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">
            {formatTime(order.created_at)}
          </p>
        </div>
        <Pill
          signal={
            order.status === 'paid' || order.status === 'shipped' || order.status === 'refunded'
          }
        >
          {order.status}
        </Pill>
        {showFlag && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleDispute();
            }}
            disabled={disputing}
            className="rounded-md border border-warning/40 px-2.5 py-1.5 font-mono-ui text-[10px] text-warning hover:bg-warning/10 disabled:opacity-50"
            data-testid={`button-flag-order-${order.id}`}
          >
            {disputing ? 'Flagging…' : 'Flag'}
          </button>
        )}
        {showRefund && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRefund();
            }}
            disabled={refunding}
            className="rounded-md border border-critical/40 px-2.5 py-1.5 font-mono-ui text-[10px] text-critical hover:bg-critical/10 disabled:opacity-50"
            data-testid={`button-refund-order-${order.id}`}
          >
            {refunding ? 'Refunding…' : 'Refund'}
          </button>
        )}
      </div>
    </button>
  );
}

function Orders() {
  const [status, setStatus] = useState('all');
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const {
    data: orders = [],
    isLoading,
    error,
  } = useQuery<Order[]>({
    queryKey: ['orders'],
    queryFn: fetchOrders,
    retry: 1,
    staleTime: 10_000,
  });

  const filtered = orders.filter((o) => status === 'all' || o.status === status);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Merchant / orders"
        title="Orders with context."
        description="Every order carries the intent, policy, and settlement state that made it happen. Click a row for the full picture."
      />

      <div className="flex gap-1 overflow-auto border-b border-foreground/10">
        {['all', 'pending', 'pending_human_review', 'paid', 'shipped', 'disputed', 'refunded', 'declined'].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 pb-3 font-mono-ui text-[10px] uppercase tracking-[.1em]',
              status === s
                ? 'border-[var(--commerce-signal)] text-foreground'
                : 'border-transparent text-muted-foreground',
            )}
            data-testid={`button-orders-filter-${s.toLowerCase()}`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="grid place-items-center px-6 py-20 text-center">
          <Loader2 size={26} className="text-muted-foreground animate-spin" />
          <p className="mt-4 font-display text-xl font-bold">Loading orders…</p>
        </div>
      )}

      {!isLoading && error && (
        <div className="grid place-items-center px-6 py-20 text-center">
          <AlertTriangle size={26} className="text-destructive" />
          <p className="mt-4 font-display text-xl font-bold">Could not load orders</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Make sure the API server is running on localhost:5000.
          </p>
          <p className="mt-1 font-mono-ui text-[10px] text-destructive">
            {(error as Error).message}
          </p>
        </div>
      )}

      {!isLoading && !error && orders.length === 0 && (
        <div className="grid place-items-center px-6 py-20 text-center">
          <ShoppingBag size={26} className="text-muted-foreground" />
          <p className="mt-4 font-display text-xl font-bold">No orders yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Orders will appear here when buyer agents make purchases.
          </p>
        </div>
      )}

      {!isLoading && !error && (
        <div className="space-y-2">
          {filtered.map((order) => (
            <OrderRow
              key={order.id}
              order={order}
              onAction={() => {
                queryClient.invalidateQueries({ queryKey: ['orders'] });
                queryClient.invalidateQueries({ queryKey: ['audit'] });
              }}
              onSelect={() => setOpenOrderId(order.id)}
            />
          ))}
        </div>
      )}
      <MerchantOrderDetailDrawer
        orderId={openOrderId}
        onClose={() => setOpenOrderId(null)}
        onAction={() => {
          queryClient.invalidateQueries({ queryKey: ['orders'] });
          queryClient.invalidateQueries({ queryKey: ['audit'] });
        }}
      />
    </div>
  );
}

function MerchantOrderDetailDrawer({
  orderId,
  onClose,
  onAction,
}: {
  orderId: number | null;
  onClose: () => void;
  onAction: () => void;
}) {
  const { toast } = useToast();
  const [action, setAction] = useState<'dispute' | 'refund' | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, error } = useQuery<{
    order: Order & { policy_decision?: CheckoutStartPolicy | null };
  }>({
    queryKey: ['order', orderId],
    queryFn: async () => {
      // fetchOrder returns plain Order; we attach the structured policy if
      // the server included it in the future. For now we just return the row.
      const order = await fetchOrder(orderId!);
      return { order };
    },
    enabled: orderId != null,
  });

  const order = data?.order;

  const submitDispute = async () => {
    if (!order) return;
    if (!reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required', description: 'Tell the buyer why.' });
      return;
    }
    setAction('dispute');
    try {
      await disputeOrder(
        order.id,
        reason.trim().slice(0, 500),
        order.workspace_id ?? 'default',
      );
      toast({ title: 'Dispute opened', description: `Order #${order.id} flagged.` });
      setReason('');
      onAction();
      onClose();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Try again.';
      toast({ variant: 'destructive', title: "Couldn't dispute", description: message });
    } finally {
      setAction(null);
    }
  };

  const submitRefund = async () => {
    if (!order) return;
    setAction('refund');
    try {
      const res = await refundOrder(order.id, order.workspace_id ?? 'default');
      toast({ title: 'Refund processed', description: `Razorpay refund ${res.refundId}.` });
      onAction();
      onClose();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Try again.';
      toast({ variant: 'destructive', title: "Couldn't refund", description: message });
    } finally {
      setAction(null);
    }
  };

  return (
    <AnimatePresence>
      {orderId != null && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex bg-black/40"
          onClick={onClose}
          data-testid="merchant-order-drawer-backdrop"
        >
          <motion.div
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="ml-auto h-full w-full max-w-[640px] overflow-y-auto bg-background p-6"
            onClick={(e) => e.stopPropagation()}
            data-testid="merchant-order-drawer"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                  order
                </p>
                <h2 className="mt-1 font-display text-xl font-bold">
                  ord_{String(orderId).padStart(4, '0')}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-lg border border-foreground/15 hover:bg-foreground/[.05]"
                data-testid="button-close-order-drawer"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            {isLoading && (
              <div className="grid place-items-center py-16">
                <Loader2 size={22} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {error && (
              <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive">
                Could not load order: {(error as Error).message}
              </div>
            )}
            {order && (
              <div className="mt-6 space-y-5">
                <div className="rounded-xl border border-foreground/10 bg-card p-4">
                  <p className="text-sm font-semibold">
                    {order.product_name ?? `Product #${order.product_id}`}
                  </p>
                  <p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">
                    buyer agent {order.buyer_agent_id} · workspace{' '}
                    {order.workspace_id ?? '—'}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <Pill signal={order.status === 'paid' || order.status === 'refunded'}>
                      {order.status}
                    </Pill>
                    <span className="font-mono-ui text-[11px]">
                      ₹{Number(order.amount).toFixed(2)}
                    </span>
                    <span className="font-mono-ui text-[10px] text-muted-foreground">
                      {new Date(order.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                {(order as { policy_decision?: CheckoutStartPolicy | null }).policy_decision && (
                  <PolicyDecisionCard
                    policy={
                      (order as { policy_decision?: CheckoutStartPolicy | null })
                        .policy_decision ?? null
                    }
                    transactionId={order.transaction_id}
                  />
                )}
                {(order.razorpay_payment_id ||
                  order.razorpay_refund_id ||
                  order.transaction_id) && (
                  <div className="rounded-xl border border-foreground/10 bg-card p-4">
                    <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                      settlement
                    </p>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono-ui text-[10px]">
                      <dt className="text-muted-foreground">transaction</dt>
                      <dd>{order.transaction_id ?? '—'}</dd>
                      <dt className="text-muted-foreground">razorpay payment</dt>
                      <dd>{order.razorpay_payment_id ?? '—'}</dd>
                      <dt className="text-muted-foreground">razorpay refund</dt>
                      <dd>{order.razorpay_refund_id ?? '—'}</dd>
                      {order.razorpay_refund_amount != null && (
                        <>
                          <dt className="text-muted-foreground">refund amount</dt>
                          <dd>₹{Number(order.razorpay_refund_amount).toFixed(2)}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">human approved</dt>
                      <dd>
                        {order.human_approved_at
                          ? new Date(order.human_approved_at).toLocaleString()
                          : '—'}
                      </dd>
                    </dl>
                    {order.transaction_id && (
                      <button
                        onClick={() => {
                          setOpenTransaction(order.transaction_id ?? null);
                        }}
                        className="mt-3 inline-flex items-center gap-2 rounded-lg border border-foreground/20 px-3 py-1.5 font-mono-ui text-[10px] hover:bg-foreground/[.06]"
                        data-testid="button-order-open-transaction"
                      >
                        <FileSearch size={12} /> Open full transaction
                      </button>
                    )}
                  </div>
                )}
                {order.dispute_reason && (
                  <div className="rounded-xl border border-warning/40 bg-warning/5 p-4">
                    <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-warning">
                      dispute reason
                    </p>
                    <p className="mt-2 text-xs">{order.dispute_reason}</p>
                  </div>
                )}
                {(order.status === 'paid' || order.status === 'shipped') && (
                  <div className="rounded-xl border border-foreground/10 bg-card p-4">
                    <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                      actions
                    </p>
                    <div className="mt-3 space-y-3">
                      <div>
                        <label className="text-xs font-semibold">
                          Flag this order
                        </label>
                        <textarea
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          rows={2}
                          placeholder="Short reason (max 500 chars)"
                          className="mt-1 w-full rounded-lg border border-input bg-background p-2 text-xs"
                          data-testid="input-order-dispute-reason"
                        />
                        <button
                          onClick={submitDispute}
                          disabled={action === 'dispute'}
                          className="mt-2 rounded-md border border-warning/40 px-3 py-1.5 font-mono-ui text-[10px] text-warning hover:bg-warning/10 disabled:opacity-50"
                          data-testid="button-order-flag"
                        >
                          {action === 'dispute' ? 'Flagging…' : 'Flag order'}
                        </button>
                      </div>
                      <button
                        onClick={submitRefund}
                        disabled={action === 'refund'}
                        className="rounded-md border border-critical/40 px-3 py-1.5 font-mono-ui text-[10px] text-critical hover:bg-critical/10 disabled:opacity-50"
                        data-testid="button-order-refund"
                      >
                        {action === 'refund' ? 'Refunding…' : 'Refund via Razorpay'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AuditRow({
  row,
  outcomeColor,
}: {
  row: AuditRowShape;
  outcomeColor: (o: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const canExpand =
    !!row.policy ||
    !!row.transaction_id ||
    row.outcome === 'auto_approved' ||
    row.outcome === 'human_approval_required';
  return (
    <div
      className="border-b border-foreground/10 last:border-0"
      data-testid="audit-row"
    >
      <button
        onClick={() => canExpand && setOpen((v) => !v)}
        disabled={!canExpand}
        className={cn(
          'grid w-full grid-cols-[140px_140px_1fr_180px] items-center gap-2 px-5 py-4 text-left',
          canExpand && 'hover:bg-foreground/[.03]',
        )}
        data-testid="button-audit-row-toggle"
      >
        <span className="font-mono-ui text-[10px] text-muted-foreground">
          {new Date(row.timestamp).toLocaleTimeString()} UTC
        </span>
        <Pill>{row.action}</Pill>
        <div className="min-w-0">
          <p className="truncate font-mono-ui text-[11px]">{row.detail ?? row.action}</p>
          {row.transaction_id && (
            <p className="mt-0.5 truncate font-mono-ui text-[10px] text-muted-foreground">
              txn {row.transaction_id}
            </p>
          )}
        </div>
        <span
          className={cn(
            'flex items-center gap-2 font-mono-ui text-[10px]',
            outcomeColor(row.outcome),
          )}
        >
          {row.outcome}
          {row.amount != null ? ` · ₹${Number(row.amount).toFixed(2)}` : ''}
          {canExpand && (
            <ChevronDown
              size={12}
              className={cn('transition-transform', open && 'rotate-180')}
            />
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden bg-muted/30"
          >
            <div className="grid gap-4 px-5 py-5 md:grid-cols-[1.2fr_.8fr]">
              {row.policy ? (
                <PolicyDecisionCard
                  policy={row.policy}
                  amount={row.amount ?? undefined}
                  transactionId={row.transaction_id}
                />
              ) : (
                <div className="rounded-xl border border-foreground/10 bg-background/40 p-4 text-xs text-muted-foreground">
                  No structured policy payload for this event.
                </div>
              )}
              <div className="space-y-3">
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                    metadata
                  </p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono-ui text-[10px]">
                    <dt className="text-muted-foreground">actor</dt>
                    <dd>{row.actor}</dd>
                    <dt className="text-muted-foreground">action</dt>
                    <dd>{row.action}</dd>
                    <dt className="text-muted-foreground">outcome</dt>
                    <dd>{row.outcome}</dd>
                    <dt className="text-muted-foreground">txn</dt>
                    <dd>{row.transaction_id ?? '—'}</dd>
                    <dt className="text-muted-foreground">workspace</dt>
                    <dd>{row.workspace_id ?? '—'}</dd>
                    <dt className="text-muted-foreground">amount</dt>
                    <dd>
                      {row.amount != null
                        ? `₹${Number(row.amount).toFixed(2)}`
                        : '—'}
                    </dd>
                  </dl>
                </div>
                {row.transaction_id ? (
                  <button
                    onClick={() => setOpenTransaction(row.transaction_id ?? null)}
                    className="inline-flex items-center gap-2 rounded-lg border border-foreground/20 px-3 py-1.5 font-mono-ui text-[10px] hover:bg-foreground/[.06]"
                    data-testid="button-audit-open-transaction"
                  >
                    <FileSearch size={12} /> Open transaction
                  </button>
                ) : null}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type AuditRowShape = AuditRow;

function ActivityPage({ audit = false }: { audit?: boolean }) {
  const { toast } = useToast();
  const [actionFilter, setActionFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [txnFilter, setTxnFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [protocolOnly, setProtocolOnly] = useState(false);

  const { data, isLoading, error } = useQuery<AuditResponse>({
    queryKey: ['audit', actionFilter, outcomeFilter, txnFilter, fromDate, toDate, protocolOnly],
    queryFn: () =>
      fetchAudit({
        action: actionFilter || undefined,
        outcome: outcomeFilter || undefined,
        transactionId: txnFilter.trim() || undefined,
        from: fromDate ? new Date(fromDate).toISOString() : undefined,
        to: toDate ? new Date(`${toDate}T23:59:59`).toISOString() : undefined,
        limit: audit ? 100 : 50,
      }),
    refetchInterval: audit ? 5000 : 3000,
  });

  const allRows = data?.rows ?? [];
  // Protocol-only filter applies to the activity stream, not the audit log.
  const protocolActions = new Set([
    'a2a_request',
    'a2a_response',
    'acp_request',
    'acp_response',
    'dependency_failure',
    'dependency_recovery',
    'razorpay_webhook',
  ]);
  const rows = !audit && protocolOnly ? allRows.filter((r) => protocolActions.has(r.action)) : allRows;
  const recentCount = allRows.filter((r) => {
    const ts = new Date(r.timestamp).getTime();
    return Date.now() - ts < 5 * 60_000;
  }).length;

  const clearAll = () => {
    setActionFilter('');
    setOutcomeFilter('');
    setTxnFilter('');
    setFromDate('');
    setToDate('');
  };
  const hasFilters = !!(
    actionFilter ||
    outcomeFilter ||
    txnFilter.trim() ||
    fromDate ||
    toDate
  );

  const setRange = (kind: '24h' | '7d' | '30d') => {
    const now = new Date();
    const from = new Date(now);
    if (kind === '24h') from.setHours(now.getHours() - 24);
    if (kind === '7d') from.setDate(now.getDate() - 7);
    if (kind === '30d') from.setDate(now.getDate() - 30);
    setFromDate(from.toISOString().slice(0, 10));
    setToDate(now.toISOString().slice(0, 10));
  };

  const handleExport = async () => {
    try {
      const exportRows = await exportAudit({
        action: actionFilter || undefined,
        outcome: outcomeFilter || undefined,
      });
      const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audit_log.json';
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Audit log exported', description: `${exportRows.length} rows downloaded.` });
    } catch (err) {
      console.error('Export failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't export the audit log. Check your connection and try again.";
      toast({
        variant: 'destructive',
        title: "Couldn't export audit log",
        description: message,
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={audit ? 'Merchant / audit log' : 'Merchant / agent activity'}
        title={audit ? 'Receipts, not guesses.' : 'The network is talking.'}
        description={
          audit
            ? 'An immutable, human-readable record of every decision and state change.'
            : 'Watch autonomous commerce resolve itself in real time.'
        }
        action={
          audit ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleExport}
                className="inline-flex items-center gap-2 rounded-full border border-foreground/20 px-4 py-2 text-sm font-semibold text-foreground hover:bg-foreground/[.06]"
                data-testid="button-export-audit"
              >
                <ArrowDownRight size={15} /> Export log
              </button>
            </div>
          ) : (
            <Pill signal>
              <span className="h-1.5 w-1.5 rounded-full bg-current" /> {recentCount} events / 5 min
            </Pill>
          )
        }
      />

      {audit ? (
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card">
          <div className="flex items-center justify-between border-b border-foreground/10 p-4">
            <div className="flex items-center gap-3 font-mono-ui text-[10px] text-muted-foreground">
              <Filter size={14} />
              {actionFilter ? `action: ${actionFilter}` : 'all actions'}
              {outcomeFilter ? ` · outcome: ${outcomeFilter}` : ''}
              {txnFilter.trim() ? ` · txn: ${txnFilter.trim()}` : ''}
              {fromDate ? ` · from ${fromDate}` : ''}
              {toDate ? ` · to ${toDate}` : ''}
              {!hasFilters ? 'Last 7 days · all events' : ''}
            </div>
            <div className="flex items-center gap-2">
              {hasFilters && (
                <button
                  onClick={clearAll}
                  className="font-mono-ui text-[10px] text-muted-foreground underline"
                  data-testid="button-audit-clear"
                >
                  Clear
                </button>
              )}
              <button
                onClick={() => setShowFilters((v) => !v)}
                className="text-muted-foreground hover:text-foreground"
                data-testid="button-audit-filter"
              >
                <SlidersHorizontal size={16} />
              </button>
            </div>
          </div>
          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 border-b border-foreground/10 bg-muted/30 px-4 py-3">
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="h-8 rounded-lg border border-foreground/15 bg-background px-3 text-xs"
                data-testid="select-audit-action"
              >
                <option value="">All actions</option>
                <option value="policy_check">Policy check</option>
                <option value="human_override">Human override</option>
                <option value="payment_captured">Payment captured</option>
                <option value="payment_failed">Payment failed</option>
                <option value="catalog_query_failed">Catalog failed</option>
                <option value="catalog_fallback">Catalog fallback</option>
              </select>
              <select
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value)}
                className="h-8 rounded-lg border border-foreground/15 bg-background px-3 text-xs"
                data-testid="select-audit-outcome"
              >
                <option value="">All outcomes</option>
                <option value="auto_approved">Auto approved</option>
                <option value="human_approval_required">Human required</option>
                <option value="approved">Approved</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
                <option value="degraded">Degraded</option>
                <option value="recovered">Recovered</option>
              </select>
              <input
                type="text"
                value={txnFilter}
                onChange={(e) => setTxnFilter(e.target.value)}
                placeholder="TXN-…"
                className="h-8 w-[160px] rounded-lg border border-foreground/15 bg-background px-3 font-mono-ui text-[11px]"
                data-testid="input-audit-txn"
              />
              <label className="flex items-center gap-1.5 font-mono-ui text-[10px] text-muted-foreground">
                from
                <input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="h-8 rounded-lg border border-foreground/15 bg-background px-2 text-xs"
                  data-testid="input-audit-from"
                />
              </label>
              <label className="flex items-center gap-1.5 font-mono-ui text-[10px] text-muted-foreground">
                to
                <input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-8 rounded-lg border border-foreground/15 bg-background px-2 text-xs"
                  data-testid="input-audit-to"
                />
              </label>
              <div className="flex items-center gap-1">
                {(['24h', '7d', '30d'] as const).map((k) => (
                  <button
                    key={k}
                    onClick={() => setRange(k)}
                    className="rounded-full border border-foreground/15 px-2.5 py-1 font-mono-ui text-[10px] hover:bg-foreground/[.06]"
                    data-testid={`button-audit-range-${k}`}
                  >
                    {k === '24h' ? 'Last 24h' : k === '7d' ? 'Last 7d' : 'Last 30d'}
                  </button>
                ))}
              </div>
            </div>
          )}
          {isLoading && (
            <div className="grid place-items-center py-16">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
            </div>
          )}
          {!isLoading && error && (
            <div className="grid place-items-center py-16 text-center">
              <p className="text-sm text-destructive">
                Couldn't load audit log: {(error as Error).message}
              </p>
            </div>
          )}
          {!isLoading && !error && rows.length === 0 && (
            <div className="grid place-items-center py-16 text-center">
              <FileText size={22} className="text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">
                {hasFilters
                  ? 'No audit entries match these filters. Try widening the date range or clearing filters.'
                  : 'No audit entries yet. Run a buyer query to generate events.'}
              </p>
            </div>
          )}
          {!isLoading &&
            rows.map((row) => (
              <AuditRow key={row.id} row={row} outcomeColor={outcomeColor} />
            ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_.95fr]">
            <div>
              <div className="flex items-center justify-between border-b border-foreground/10 pb-4">
                <span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                  event stream
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setProtocolOnly((v) => !v)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono-ui text-[10px]',
                      protocolOnly
                        ? 'border-[var(--commerce-signal)] bg-[var(--commerce-signal)]/10 text-foreground'
                        : 'border-foreground/15 text-muted-foreground hover:bg-foreground/[.06]',
                    )}
                    data-testid="button-protocol-only"
                  >
                    {protocolOnly ? 'Protocol only' : 'All events'}
                  </button>
                  <span className="font-mono-ui text-[10px] text-foreground">
                    {recentCount} events / 5 min
                  </span>
                </div>
              </div>
              <div className="mt-3">
                {isLoading && (
                  <div className="grid place-items-center py-8">
                    <Loader2 size={18} className="animate-spin text-muted-foreground" />
                  </div>
                )}
                {!isLoading && rows.length === 0 && (
                  <p className="py-8 text-center text-sm text-muted-foreground">No events yet.</p>
                )}
                {!isLoading &&
                  rows.map((row) => (
                    <div key={row.id} className="flex gap-4 border-b border-foreground/5 py-4">
                      <span className="font-mono-ui text-[10px] text-muted-foreground">
                        {new Date(row.timestamp).toLocaleTimeString()}
                      </span>
                      <div>
                        <p className="text-xs">{row.detail ?? row.action}</p>
                        <p
                          className={cn('mt-1 font-mono-ui text-[9px]', outcomeColor(row.outcome))}
                        >
                          {row.actor} · {row.action}
                        </p>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
            <div className="rounded-xl bg-[var(--commerce-surface-sunken)] p-5 text-[var(--commerce-ink)]">
              <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-[var(--commerce-text-muted)]">
                <Terminal size={14} /> latest trace
              </div>
              <div className="mt-7 space-y-4 font-mono-ui text-[11px] leading-5">
                {rows.length === 0 ? (
                  <p className="text-[var(--commerce-text-muted)]/60">No trace data yet.</p>
                ) : (
                  rows.slice(0, 5).map((row) => (
                    <div key={row.id}>
                      <p>
                        <span className="text-[var(--commerce-signal-strong)]">
                          {new Date(row.timestamp).toLocaleTimeString()}
                        </span>{' '}
                        {row.action}
                      </p>
                      {row.detail && <p className="pl-4 text-[var(--commerce-text-muted)]/70">{row.detail}</p>}
                    </div>
                  ))
                )}
                {rows.length > 0 && (
                  <div className="mt-6 border-t border-[var(--commerce-border)] pt-4 text-[var(--commerce-signal-strong)]">
                    stream active · {rows.length} total events
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Reusable: PolicyDecisionCard ────────────────────────────────────────────

function PolicyDecisionCard({
  policy,
  amount,
  transactionId,
  compact = false,
}: {
  policy: CheckoutStartPolicy | null | undefined;
  amount?: number;
  transactionId?: string | null;
  compact?: boolean;
}) {
  if (!policy) {
    return (
      <div className="rounded-xl border border-foreground/10 bg-muted/40 p-4 text-xs text-muted-foreground">
        Policy not recorded for this event.
      </div>
    );
  }
  const fmt = (n: number) => `₹${n.toFixed(2)}`;
  const buyerOk = policy.buyer.limit != null && !policy.buyer.exceeded;
  const merchantOk = !policy.merchant.exceeded;
  return (
    <div
      className={cn('rounded-xl border border-foreground/10 bg-card p-4 sm:p-5', compact && 'p-3')}
      data-testid="policy-decision-card"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
          <ShieldCheck size={14} /> authorization decision
        </div>
        {transactionId && (
          <span className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
            {transactionId}
          </span>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-foreground/10 bg-background/50 p-3">
          <p className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
            amount
          </p>
          <p className="mt-1 text-base font-semibold">{fmt(policy.amount ?? amount ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-foreground/10 bg-background/50 p-3">
          <p className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
            result
          </p>
          <p
            className={cn(
              'mt-1 text-sm font-semibold',
              policy.decision === 'auto_approved'
                ? 'text-positive'
                : policy.decision === 'human_approval_required'
                  ? 'text-warning'
                  : 'text-muted-foreground',
            )}
          >
            {policy.decision === 'auto_approved'
              ? 'Auto approved'
              : policy.decision === 'human_approval_required'
                ? 'Human approval required'
                : 'No match'}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-foreground/10 bg-background/50 p-3">
          <p className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
            buyer ceiling
          </p>
          <p className="mt-1 text-sm">
            {policy.buyer.limit != null ? fmt(policy.buyer.limit) : 'No buyer limit set'}
            <span
              className={cn(
                'ml-2 font-mono-ui text-[10px]',
                policy.buyer.exceeded
                  ? 'text-warning'
                  : 'text-positive',
              )}
            >
              {policy.buyer.exceeded ? '✗ exceeded' : '✓ passed'}
            </span>
          </p>
        </div>
        <div className="rounded-lg border border-foreground/10 bg-background/50 p-3">
          <p className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
            merchant ceiling
          </p>
          <p className="mt-1 text-sm">
            {fmt(policy.merchant.limit)}
            <span
              className={cn(
                'ml-2 font-mono-ui text-[10px]',
                policy.merchant.exceeded
                  ? 'text-warning'
                  : 'text-positive',
              )}
            >
              {policy.merchant.exceeded ? '✗ exceeded' : '✓ passed'}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-4 rounded-lg border border-foreground/10 bg-background/50 p-3">
        <p className="font-mono-ui text-[9px] uppercase tracking-[.1em] text-muted-foreground">
          triggered by
        </p>
        <p className="mt-1 text-sm font-semibold">
          {policy.ceilingSource === 'both'
            ? 'Both ceilings'
            : policy.ceilingSource === 'merchant_ceiling'
              ? 'Merchant ceiling'
              : policy.ceilingSource === 'buyer_ceiling'
                ? 'Buyer ceiling'
                : 'None — within policy'}
        </p>
        {policy.reasons.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            {policy.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Reusable: TransactionDetailDrawer ───────────────────────────────────────

// Module-level drawer bus; setOpenTransaction opens the transaction drawer from anywhere.
let openTxn: string | null = null;
const txnSubs = new Set<(t: string | null) => void>();
export function setOpenTransaction(txn: string | null) {
  openTxn = txn;
  txnSubs.forEach((fn) => fn(txn));
}
function useOpenTransaction(): [string | null, (t: string | null) => void] {
  const [txn, setTxn] = useState<string | null>(openTxn);
  useEffect(() => {
    txnSubs.add(setTxn);
    if (openTxn !== txn) setTxn(openTxn);
    return () => {
      txnSubs.delete(setTxn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [txn, setOpenTransaction];
}

function TransactionDetailDrawer({
  txnId,
  onClose,
}: {
  txnId: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery<TransactionDetail>({
    queryKey: ['transaction', txnId],
    queryFn: () => fetchTransactionDetail(txnId!),
    enabled: !!txnId,
  });

  return (
    <AnimatePresence>
      {txnId && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex bg-black/40"
          onClick={onClose}
          data-testid="transaction-drawer-backdrop"
        >
          <motion.div
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'tween', duration: 0.2 }}
            className="ml-auto h-full w-full max-w-[640px] overflow-y-auto bg-background p-6"
            onClick={(e) => e.stopPropagation()}
            data-testid="transaction-drawer"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                  transaction
                </p>
                <h2 className="mt-1 font-display text-xl font-bold">{txnId}</h2>
              </div>
              <button
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-lg border border-foreground/15 hover:bg-foreground/[.05]"
                data-testid="button-close-transaction-drawer"
                aria-label="Close"
              >
                <X size={15} />
              </button>
            </div>
            {isLoading && (
              <div className="grid place-items-center py-16">
                <Loader2 size={22} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {error && (
              <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive">
                Could not load transaction: {(error as Error).message}
              </div>
            )}
            {data && (
              <div className="mt-6 space-y-5">
                <div>
                  <h3 className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                    orders
                  </h3>
                  {(data.orders?.length ?? 0) === 0 && (
                    <p className="mt-2 text-sm text-muted-foreground">No order rows.</p>
                  )}
                  {(data.orders ?? []).map((o) => (
                    <div
                      key={o.id}
                      className="mt-2 rounded-lg border border-foreground/10 bg-card p-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold">
                          {o.product_name ?? `Product #${o.product_id}`}
                        </span>
                        <Pill
                          signal={
                            o.status === 'paid' || o.status === 'refunded'
                          }
                        >
                          {o.status}
                        </Pill>
                      </div>
                      <p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">
                        ₹{Number(o.amount).toFixed(2)} · ord_{String(o.id).padStart(4, '0')} ·{' '}
                        workspace {o.workspace_id ?? '—'}
                      </p>
                      {(o as { policy_decision?: CheckoutStartPolicy | null }).policy_decision && (
                        <div className="mt-3">
                          <PolicyDecisionCard
                            policy={
                              (o as { policy_decision?: CheckoutStartPolicy | null })
                                .policy_decision ?? null
                            }
                            transactionId={txnId}
                            compact
                          />
                        </div>
                      )}
                      {(o.razorpay_payment_id || o.razorpay_refund_id) && (
                        <div className="mt-3 grid grid-cols-1 gap-2 text-[10px] font-mono-ui sm:grid-cols-2">
                          {o.razorpay_payment_id && (
                            <div>
                              <p className="text-muted-foreground">razorpay payment</p>
                              <p>{o.razorpay_payment_id}</p>
                            </div>
                          )}
                          {o.razorpay_refund_id && (
                            <div>
                              <p className="text-muted-foreground">razorpay refund</p>
                              <p>{o.razorpay_refund_id}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div>
                  <h3 className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                    audit events ({data.audit?.length ?? 0})
                  </h3>
                  <div className="mt-2 space-y-1">
                    {(data.audit ?? []).map((a) => (
                      <div
                        key={a.id}
                        className="flex items-start gap-3 rounded-md border border-foreground/10 bg-card p-2.5"
                      >
                        <span className="w-[68px] shrink-0 font-mono-ui text-[10px] text-muted-foreground">
                          {new Date(a.timestamp).toLocaleTimeString()}
                        </span>
                        <Pill>{a.action}</Pill>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs">{a.detail ?? a.action}</p>
                          <p className="mt-0.5 font-mono-ui text-[9px] text-muted-foreground">
                            {a.actor} · {a.outcome}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Demo Controls section (Settings → Demo controls) ───────────────────────

function DemoControlsSection() {
  const { toast } = useToast();
  const { data: debugStatus, refetch } = useQuery<DebugStatus>({
    queryKey: ['debug-status'],
    queryFn: fetchDebugStatus,
    refetchInterval: 3000,
  });
  const simulating = debugStatus?.simulateSupplierFailure ?? false;
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => toggleDebugFailure(enabled),
    onSuccess: (status) => {
      toast({
        title: status.simulateSupplierFailure
          ? 'Supplier outage enabled'
          : 'Supplier outage disabled',
        description: status.simulateSupplierFailure
          ? 'Next buyer query will treat the supplier as unreachable.'
          : 'Supplier is healthy again.',
      });
      refetch();
    },
    onError: (err) => {
      const message =
        err instanceof ApiError ? err.message : "Couldn't update debug mode. Try again.";
      toast({
        variant: 'destructive',
        title: "Couldn't update debug mode",
        description: message,
      });
    },
  });

  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
      <div className="flex items-start gap-4">
        <Radio size={20} className="mt-1 text-[var(--commerce-signal)]" />
        <div className="flex-1">
          <h3 className="font-display text-xl font-bold">Demo controls</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Force the supplier agent to fail so you can demonstrate the retry + fallback + recovery
            trace. Real backend toggle — no mock state.
          </p>
          <div className="mt-7 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-foreground/10 pb-4">
              <div>
                <p className="text-sm">Supplier outage</p>
                <p className="mt-0.5 font-mono-ui text-[10px] text-muted-foreground">
                  When enabled, the next buyer query will see the supplier as unreachable and fall
                  back to the cached catalog.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono-ui text-[10px]',
                    simulating
                      ? 'border-warning/40 bg-warning/10 text-warning'
                      : 'border-positive/40 bg-positive/10 text-positive',
                  )}
                  data-testid="demo-controls-state"
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      simulating ? 'bg-warning' : 'bg-positive',
                    )}
                  />
                  {simulating ? 'Simulated outage' : 'Healthy'}
                </span>
                <button
                  onClick={() => toggleMutation.mutate(!simulating)}
                  disabled={toggleMutation.isPending}
                  className="rounded-md border border-foreground/20 px-3 py-1.5 font-mono-ui text-[10px] hover:bg-foreground/[.06] disabled:opacity-50"
                  data-testid="button-toggle-supplier-outage"
                >
                  {toggleMutation.isPending ? 'Saving…' : simulating ? 'Stop outage' : 'Simulate outage'}
                </button>
              </div>
            </div>
            <p className="font-mono-ui text-[10px] text-muted-foreground">
              Other failure simulations (A2A timeout, ACP failure, payment-gateway failure) are not
              yet implemented in the backend — they will appear here as the API exposes them.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings, isLoading } = useQuery<MerchantSettings>({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });

  const [maxCap, setMaxCap] = useState('');
  const [requireHuman, setRequireHuman] = useState(true);
  const [saved, setSaved] = useState(false);

  // Sync local state when settings load
  useEffect(() => {
    if (settings) {
      setMaxCap(String(settings.maxAutoApprove));
      setRequireHuman(settings.requireHumanAboveCap);
    }
  }, [settings]);

  const handleSave = async () => {
    const val = parseFloat(maxCap.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(val) || val <= 0) return;
    try {
      await updateSettings({ maxAutoApprove: val, requireHumanAboveCap: requireHuman });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      toast({ title: 'Settings saved', description: 'Your policy changes are live.' });
    } catch (err) {
      console.error('Failed to save settings:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't update settings. Check your connection and try again.";
      toast({
        variant: 'destructive',
        title: "Couldn't update settings",
        description: message,
      });
    }
  };

  return (
    <div className="space-y-7">
      <PageHeading
        eyebrow="Workspace / settings"
        title="Set the boundaries."
        description="Controls that keep autonomous decisions aligned with your intent."
        action={
          <Button
            onClick={handleSave}
            className="h-10 rounded-lg bg-foreground text-background"
            data-testid="button-save-settings"
          >
            {saved ? (
              <>
                <Check size={15} className="mr-2" /> Saved
              </>
            ) : (
              'Save changes'
            )}
          </Button>
        }
      />
      <div className="grid max-w-[820px] gap-4">
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <ShieldCheck
              className="mt-1 text-foreground"
              size={20}
            />
            <div className="flex-1">
              <h3 className="font-display text-xl font-bold">Decision policy</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Default rules applied before an agent can commit.
              </p>
              <div className="mt-7 space-y-5">
                {/* Max auto-approve cap — real API */}
                <div className="flex items-center justify-between border-b border-foreground/10 pb-4 last:border-0 last:pb-0">
                  <span className="text-sm">Auto-approve orders under</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">$</span>
                    <input
                      type="number"
                      value={maxCap}
                      onChange={(e) => setMaxCap(e.target.value)}
                      className="h-8 w-24 rounded-lg border border-foreground/15 bg-background px-3 text-right font-mono-ui text-[10px] outline-none focus:border-[var(--commerce-signal)]"
                      min="0"
                      step="10"
                      data-testid="input-settings-max-auto-approve"
                    />
                  </div>
                </div>
                {/* Require human review — real API */}
                <div className="flex items-center justify-between border-b border-foreground/10 pb-4 last:border-0 last:pb-0">
                  <span className="text-sm">Require human review above cap</span>
                  <button
                    onClick={() => setRequireHuman((v) => !v)}
                    className={cn(
                      'flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono-ui text-[10px]',
                      requireHuman
                        ? 'border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10'
                        : 'border-foreground/15 text-muted-foreground',
                    )}
                    data-testid="button-setting-require-human"
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        requireHuman ? 'bg-[var(--commerce-signal)]' : 'bg-muted-foreground',
                      )}
                    />
                    {requireHuman ? 'Enabled' : 'Off'}
                  </button>
                </div>
                {/* Test mode — read-only */}
                <div className="flex items-center justify-between border-b border-foreground/10 pb-4 last:border-0 last:pb-0">
                  <span className="text-sm">Test mode payments</span>
                  <span className="flex items-center gap-2 rounded-full border border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10 px-3 py-1.5 font-mono-ui text-[10px]">
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--commerce-signal)]" /> Enabled
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <PaymentGatewaySection />
        <DemoControlsSection />
      </div>
    </div>
  );
}

// ── Payment gateway (per-merchant Razorpay credentials) ─────────────────────

function PaymentGatewaySection() {
  const { toast } = useToast();
  const { data: rp, isLoading } = useQuery<RazorpaySettings>({
    queryKey: ['razorpay-settings'],
    queryFn: fetchRazorpaySettings,
    staleTime: 60_000,
  });

  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<'idle' | 'pass' | 'fail'>('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [showSecrets, setShowSecrets] = useState(false);

  const configured = rp?.configured ?? false;

  const handleSave = async () => {
    if (!keyId.trim() || !keySecret.trim() || !webhookSecret.trim()) {
      toast({
        variant: 'destructive',
        title: 'Missing fields',
        description: 'Fill in key ID, key secret, and webhook secret before saving.',
      });
      return;
    }
    if (!keyId.startsWith('rzp_test_')) {
      toast({
        variant: 'destructive',
        title: 'Wrong key type',
        description: 'Only Razorpay test-mode keys (rzp_test_…) are accepted here.',
      });
      return;
    }
    setSaving(true);
    setTestState('idle');
    setTestMessage(null);
    try {
      const res = await saveRazorpaySettings({
        keyId: keyId.trim(),
        keySecret: keySecret.trim(),
        webhookSecret: webhookSecret.trim(),
      });
      // Clear the secret inputs after a successful save — they are write-only.
      setKeySecret('');
      setWebhookSecret('');
      setShowSecrets(false);
      setKeyId(res.keyId);
      toast({
        title: 'Credentials saved',
        description: 'Razorpay keys are encrypted at rest and ready to use.',
      });
    } catch (err) {
      console.error('Save Razorpay credentials failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't save credentials. Check your connection and try again.";
      toast({
        variant: 'destructive',
        title: "Couldn't save credentials",
        description: message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestState('idle');
    setTestMessage(null);
    try {
      const res: RazorpayTestResult = await testRazorpaySettings();
      if (res.valid) {
        setTestState('pass');
        setTestMessage(res.message);
        toast({ title: 'Connection valid', description: res.message });
      } else {
        setTestState('fail');
        setTestMessage(res.message);
        toast({
          variant: 'destructive',
          title: 'Connection failed',
          description: res.message,
        });
      }
    } catch (err) {
      console.error('Test Razorpay credentials failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't reach the test endpoint. Check your connection and try again.";
      setTestState('fail');
      setTestMessage(message);
      toast({
        variant: 'destructive',
        title: "Couldn't test connection",
        description: message,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      id="payment-gateway"
      className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7"
    >
      <div className="flex items-start gap-4">
        <KeyRound
          className="mt-1 text-foreground"
          size={20}
        />
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-bold">Payment gateway</h3>
            {configured ? (
              <span className="flex items-center gap-2 rounded-full border border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10 px-3 py-1.5 font-mono-ui text-[10px] text-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--commerce-signal)]" /> connected
              </span>
            ) : (
              <span className="flex items-center gap-2 rounded-full border border-warning/40 bg-warning/5 px-3 py-1.5 font-mono-ui text-[10px] text-warning">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" /> not configured
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect your Razorpay test keys so checkout can open a real payment modal. Secrets are
            encrypted at rest.
          </p>

          <div className="mt-7 space-y-5">
            <label className="block text-xs font-semibold">
              Razorpay key ID
              <input
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="rzp_test_…"
                className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono-ui text-xs outline-none focus:border-[var(--commerce-signal)]"
                data-testid="input-razorpay-key-id"
              />
            </label>

            {configured && !showSecrets ? (
              <div className="rounded-lg border border-foreground/10 bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                <LockKeyhole size={12} className="mr-2 inline" />
                Key secret and webhook secret are configured
                {rp?.updatedAt ? ` on ${new Date(rp.updatedAt).toLocaleDateString()}` : ''}. They
                are write-only — type new values below to replace them.
              </div>
            ) : null}

            {(showSecrets || !configured) && (
              <>
                <label className="block text-xs font-semibold">
                  Key secret
                  <input
                    type="password"
                    value={keySecret}
                    onChange={(e) => setKeySecret(e.target.value)}
                    placeholder={
                      configured ? '•••••• (enter new value to replace)' : 'Razorpay key secret'
                    }
                    className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono-ui text-xs outline-none focus:border-[var(--commerce-signal)]"
                    data-testid="input-razorpay-key-secret"
                    autoComplete="off"
                  />
                </label>
                <label className="block text-xs font-semibold">
                  Webhook secret
                  <input
                    type="password"
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder={
                      configured ? '•••••• (enter new value to replace)' : 'Razorpay webhook secret'
                    }
                    className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono-ui text-xs outline-none focus:border-[var(--commerce-signal)]"
                    data-testid="input-razorpay-webhook-secret"
                    autoComplete="off"
                  />
                </label>
              </>
            )}

            {configured && !showSecrets && (
              <button
                onClick={() => setShowSecrets(true)}
                className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground underline underline-offset-4 hover:text-foreground"
                data-testid="button-rotate-razorpay-secrets"
              >
                Replace secrets
              </button>
            )}

            {testState !== 'idle' && testMessage && (
              <div
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-4 py-3 text-xs',
                  testState === 'pass'
                    ? 'border-positive/40 bg-positive/5 text-positive'
                    : 'border-destructive/40 bg-destructive/5 text-destructive',
                )}
                data-testid="razorpay-test-result"
              >
                {testState === 'pass' ? (
                  <Check size={14} className="mt-0.5" />
                ) : (
                  <AlertTriangle size={14} className="mt-0.5" />
                )}
                <span>{testMessage}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                onClick={handleTest}
                disabled={testing || !configured}
                variant="outline"
                className="h-10 rounded-lg"
                data-testid="button-razorpay-test"
              >
                {testing ? (
                  <>
                    <Loader2 size={14} className="mr-2 animate-spin" /> Testing…
                  </>
                ) : (
                  'Test connection'
                )}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving}
                className="h-10 rounded-lg bg-foreground text-background"
                data-testid="button-razorpay-save"
              >
                {saving ? (
                  <>
                    <Loader2 size={14} className="mr-2 animate-spin" /> Saving…
                  </>
                ) : (
                  'Save credentials'
                )}
              </Button>
            </div>
            <p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">
              Test mode only · no live keys
            </p>
            {isLoading && null}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Growth / upsell suggestions (Stage 10 / A) ──────────────────────────────

function renderUpsellSuggestions({
  rec,
  suggestions,
  sessionId,
  maxSpend,
  dismissed,
  setDismissed,
  upsellState,
  setUpsellState,
  toast,
}: {
  rec: Product;
  suggestions: NonNullable<BuyerQueryResult['suggestions']>;
  sessionId: string | null;
  maxSpend: number | undefined;
  dismissed: Set<number>;
  setDismissed: (next: Set<number>) => void;
  upsellState: { busy: boolean; result: UpsellAcceptResponse | null; error: string | null };
  setUpsellState: (next: {
    busy: boolean;
    result: UpsellAcceptResponse | null;
    error: string | null;
  }) => void;
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const visible = suggestions.filter((s) => !dismissed.has(s.id));
  if (visible.length === 0) return null;

  const handleAccept = async (suggestionId: number) => {
    if (!sessionId) return;
    setUpsellState({ busy: true, result: null, error: null });
    try {
      const res = await acceptUpsell({
        sessionId,
        suggestionId,
        primaryProductId: rec.id,
        buyerMaxSpend: maxSpend,
      });
      setUpsellState({ busy: false, result: res, error: null });
      if (res.policyResult === 'auto_approved') {
        toast({
          title: 'Added to your order',
          description: `Combined total $${res.combinedTotal.toFixed(2)} stays under both caps.`,
        });
      } else if (res.exceededCeiling === 'buyer' || res.exceededCeiling === 'both') {
        toast({
          variant: 'destructive',
          title: 'Above the limit you set',
          description: `Combined $${res.combinedTotal.toFixed(2)} needs your approval before checkout.`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Above the merchant cap',
          description: `Combined $${res.combinedTotal.toFixed(2)} needs human approval.`,
        });
      }
    } catch (err) {
      console.error('upsell accept failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Couldn't add that to the order. Try again in a moment.";
      setUpsellState({ busy: false, result: null, error: message });
      toast({
        variant: 'destructive',
        title: "Couldn't add the suggestion",
        description: message,
      });
    }
  };

  return (
    <div className="mt-4 space-y-2" data-testid="upsell-suggestions">
      <div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">
        <Sparkles size={11} /> You may also want
      </div>
      {visible.map((s) => {
        const combined = rec.price + s.price;
        return (
          <div
            key={s.id}
            className="flex items-center justify-between gap-2 rounded-lg border border-foreground/10 bg-background/60 px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{s.name}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {s.reason} · ${s.price.toFixed(2)} · combined ${combined.toFixed(2)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => handleAccept(s.id)}
                disabled={upsellState.busy}
                className="rounded-md border border-foreground/15 px-2 py-1 font-mono-ui text-[10px] hover:bg-foreground/[.05] disabled:opacity-50"
                data-testid={`button-accept-upsell-${s.id}`}
              >
                {upsellState.busy ? 'Checking…' : 'Add to order'}
              </button>
              <button
                onClick={() => setDismissed(new Set([...dismissed, s.id]))}
                className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-foreground/[.05] hover:text-foreground"
                aria-label="Dismiss suggestion"
                data-testid={`button-dismiss-upsell-${s.id}`}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BuyerOrderCard({ order }: { order: Order }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const canDispute = order.status === 'paid' || order.status === 'shipped';

  // Fetch the matching audit events for this order's transaction so the
  // user can see why the agent picked it. Falls back to "no trace" if the
  // backend hasn't recorded one.
  const trace = useQuery<TransactionDetail>({
    queryKey: ['transaction', order.transaction_id],
    queryFn: () => fetchTransactionDetail(order.transaction_id ?? ''),
    enabled: open && !!order.transaction_id,
  });

  const handleDispute = async () => {
    if (!reason.trim()) {
      toast({
        variant: 'destructive',
        title: 'Reason required',
        description: 'Tell the agent what went wrong.',
      });
      return;
    }
    setBusy(true);
    try {
      await disputeOrder(
        order.id,
        reason.trim().slice(0, 500),
        getOrCreateBuyerWorkspaceId(),
      );
      toast({ title: 'Order flagged', description: 'Dispute opened with the merchant.' });
      setReason('');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Try again.';
      toast({ variant: 'destructive', title: "Couldn't flag", description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-foreground/10 bg-card"
      data-testid={`buyer-order-${order.id}`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-5 text-left hover:bg-muted/30"
        data-testid={`button-toggle-buyer-order-${order.id}`}
      >
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted">
            <Package size={16} />
          </div>
          <div>
            <p className="text-sm font-semibold">
              {order.product_name ?? `Product #${order.product_id}`}
            </p>
            <p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">
              ord_{String(order.id).padStart(4, '0')} ·{' '}
              {new Date(order.created_at).toLocaleString()} ·{' '}
              {order.transaction_id ? `txn ${order.transaction_id}` : 'no txn yet'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-sm font-semibold">₹{Number(order.amount).toFixed(2)}</p>
            <Pill signal={order.status === 'paid' || order.status === 'refunded'}>
              {order.status}
            </Pill>
          </div>
          <ChevronDown
            size={14}
            className={cn('transition-transform text-muted-foreground', open && 'rotate-180')}
          />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-foreground/10"
          >
            <div className="grid gap-5 p-5 md:grid-cols-[1.1fr_.9fr]">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                  why this pick
                </p>
                {!order.transaction_id && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No transaction recorded yet.
                  </p>
                )}
                {order.transaction_id && trace.isLoading && (
                  <div className="mt-3 grid place-items-center py-6">
                    <Loader2 size={16} className="animate-spin text-muted-foreground" />
                  </div>
                )}
                {order.transaction_id && trace.data && (
                  <div className="mt-2 space-y-1">
                    {(trace.data.audit?.length ?? 0) === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No audit events for this transaction.
                      </p>
                    )}
                    {(trace.data.audit ?? []).slice(0, 10).map((a) => (
                      <div
                        key={a.id}
                        className="flex items-start gap-2 rounded-md border border-foreground/10 bg-background p-2 text-xs"
                      >
                        <span className="w-[68px] shrink-0 font-mono-ui text-[10px] text-muted-foreground">
                          {new Date(a.timestamp).toLocaleTimeString()}
                        </span>
                        <Pill>{a.action}</Pill>
                        <p className="min-w-0 truncate text-xs">{a.detail ?? a.action}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {canDispute ? (
                <div>
                  <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                    flag this order
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Pick a short reason. The merchant receives it as a dispute.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-1">
                    {['Wrong product', 'Payment issue', 'Duplicate charge', 'Other'].map(
                      (label) => (
                        <button
                          key={label}
                          onClick={() => setReason(label)}
                          className={cn(
                            'rounded-md border px-2 py-1.5 text-left text-[11px] hover:bg-muted',
                            reason === label
                              ? 'border-[var(--commerce-signal)] bg-[var(--commerce-signal)]/5'
                              : 'border-foreground/15',
                          )}
                          data-testid={`button-buyer-dispute-reason-${label.replace(/\s+/g, '-').toLowerCase()}`}
                        >
                          {label}
                        </button>
                      ),
                    )}
                  </div>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={500}
                    className="mt-2 w-full rounded-lg border border-input bg-background p-2 text-xs"
                    placeholder="Optional detail (max 500 chars)"
                    data-testid="input-buyer-dispute-reason"
                  />
                  <button
                    onClick={handleDispute}
                    disabled={busy}
                    className="mt-2 rounded-md border border-warning/40 px-3 py-1.5 font-mono-ui text-[10px] text-warning hover:bg-warning/10 disabled:opacity-50"
                    data-testid="button-buyer-dispute-submit"
                  >
                    {busy ? 'Flagging…' : 'Flag this order'}
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-foreground/10 bg-background/50 p-4 text-xs text-muted-foreground">
                  Dispute can be opened once the order is paid. Current status:{' '}
                  <span className="font-mono-ui text-foreground">{order.status}</span>.
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function BuyerSettings() {
  const { toast } = useToast();
  const ws = getOrCreateBuyerWorkspaceId();
  const { data, isLoading } = useQuery<BuyerSession>({
    queryKey: ['buyer-session', ws],
    queryFn: () => fetchBuyerSession(ws),
  });
  const [maxSpend, setMaxSpend] = useState<string>('');
  const [autonomy, setAutonomy] = useState<BuyerSession['autonomy']>('recommend_only');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setMaxSpend(data.maxSpend != null ? String(data.maxSpend) : '');
      setAutonomy(data.autonomy);
    }
  }, [data]);

  const save = async () => {
    const parsed = maxSpend.trim() === '' ? null : Number(maxSpend);
    if (parsed != null && (!Number.isFinite(parsed) || parsed <= 0)) {
      toast({
        variant: 'destructive',
        title: 'Invalid limit',
        description: 'Session limit must be a positive number or blank.',
      });
      return;
    }
    setSaving(true);
    try {
      await updateBuyerSession({ workspaceId: ws, maxSpend: parsed, autonomy });
      toast({ title: 'Buyer session saved', description: 'Settings applied to next query.' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Try again.';
      toast({ variant: 'destructive', title: "Couldn't save", description: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Buyer / settings"
        title="Your agent's leash."
        description="Cap the spend Northstar can commit without your approval, and decide how often it asks."
      />
      <div className="rounded-2xl border border-foreground/10 bg-card p-6 sm:p-7">
        {isLoading ? (
          <div className="grid place-items-center py-8">
            <Loader2 size={18} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="text-xs font-semibold">Session spend limit (₹)</label>
              <p className="mt-1 text-xs text-muted-foreground">
                Leave blank to disable the buyer-side cap. The merchant cap still applies.
              </p>
              <input
                type="number"
                min={0}
                value={maxSpend}
                onChange={(e) => setMaxSpend(e.target.value)}
                className="mt-2 h-10 w-full max-w-[240px] rounded-lg border border-input bg-background px-3 text-sm"
                data-testid="input-buyer-max-spend"
              />
            </div>
            <div>
              <p className="text-xs font-semibold">Autonomy</p>
              <div className="mt-2 space-y-2">
                {(
                  [
                    ['recommend_only', 'Recommend only — never purchase without asking'],
                    ['ask_before', 'Ask before every purchase'],
                    ['auto_up_to_limit', 'Auto-approve up to your session limit'],
                  ] as const
                ).map(([val, label]) => (
                  <label
                    key={val}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs',
                      autonomy === val
                        ? 'border-[var(--commerce-signal)] bg-[var(--commerce-signal)]/5'
                        : 'border-foreground/15',
                    )}
                  >
                    <input
                      type="radio"
                      name="autonomy"
                      value={val}
                      checked={autonomy === val}
                      onChange={() => setAutonomy(val)}
                      className="accent-[var(--commerce-signal)]"
                      data-testid={`radio-autonomy-${val}`}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
              data-testid="button-save-buyer-session"
            >
              {saving ? 'Saving…' : 'Save session'}
            </button>
            <p className="font-mono-ui text-[10px] text-muted-foreground">
              workspace {ws.slice(0, 12)}…
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function BuyerConsole({ subpage, theme }: { subpage: string; theme: Theme }) {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState('');
  const [maxSpend, setMaxSpend] = useState<string>('180');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceResult, setTraceResult] = useState<BuyerQueryResult | null>(null);
  const [traceEvidence, setTraceEvidence] = useState<string | undefined>(undefined);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<number>>(new Set());
  const [upsellState, setUpsellState] = useState<{
    busy: boolean;
    result: UpsellAcceptResponse | null;
    error: string | null;
  }>({ busy: false, result: null, error: null });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const sample = 'Find a warm desk lamp under $180 for evening reading.';
  const isCheckout = subpage === '/buyer/checkout';
  const isTrace = subpage === '/buyer/trace';
  const isOrders = subpage === '/buyer/orders';
  const isSettings = subpage === '/buyer/settings';

  const { data: buyerOrders, isLoading: ordersLoading } = useQuery<Order[]>({
    queryKey: ['orders'],
    queryFn: fetchOrders,
    refetchInterval: 5000,
    enabled: isOrders,
  });

  const { data: buyerSession } = useQuery<BuyerSession>({
    queryKey: ['buyer-session', getOrCreateBuyerWorkspaceId()],
    queryFn: () => fetchBuyerSession(getOrCreateBuyerWorkspaceId()),
    staleTime: 30_000,
  });

  if (isSettings) return <BuyerSettings />;

  const handleSubmit = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast({
        variant: 'destructive',
        title: 'Type a request first',
        description: 'Tell the agent what you want to find before submitting.',
      });
      return;
    }
    if (loading) return;
    setSubmitted(true);
    setLoading(true);
    setError(null);
    setTraceSteps([]);
    setTraceResult(null);
    setTraceEvidence(undefined);
    setUpsellState({ busy: false, result: null, error: null });
    setDismissedSuggestions(new Set());
    setElapsed(null);
    const start = Date.now();
    const parsedCap = parseFloat(maxSpend.replace(/[^0-9.]/g, ''));
    const capArg = Number.isFinite(parsedCap) && parsedCap > 0 ? parsedCap : undefined;
    try {
      const res = await submitBuyerQuery(trimmed, { maxSpend: capArg });
      setSessionId(res.sessionId);
      setTraceSteps(res.steps);
      setTraceResult(res.result);
      setTraceEvidence(res.evidence);
      setElapsed(Date.now() - start);
      setLoading(false);
    } catch (err) {
      console.error('Buyer query failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof NetworkUnreachableError
            ? err.message
            : "Couldn't send your request. Check your connection and try again.";
      setError(message);
      setLoading(false);
      toast({
        variant: 'destructive',
        title: "Couldn't send your request",
        description: message,
      });
    }
  };

  const rec = traceResult?.recommendedProduct;

  if (isOrders) {
    const orderList = (buyerOrders ?? []).filter(
      (o) => o.workspace_id == null || o.workspace_id === getOrCreateBuyerWorkspaceId(),
    );
    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Buyer / order history"
          title="Your commitments."
          description="Completed and test-mode purchases made by Northstar Agent. Open a row for the why-this-pick trace and dispute controls."
        />
        {ordersLoading && (
          <div className="grid place-items-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        )}
        {!ordersLoading && orderList.length === 0 && (
          <div className="grid place-items-center py-16 text-center">
            <Package size={22} className="text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">
              No orders yet. Run a query and checkout to see orders here.
            </p>
          </div>
        )}
        {!ordersLoading && (
          <div className="space-y-3">
            {orderList.map((o) => (
              <BuyerOrderCard key={o.id} order={o} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const buyerSubpage = isCheckout ? 'checkout' : isTrace ? 'trace' : 'console';

  return (
    <div className="space-y-7">
      <PageHeading
        eyebrow={
          isCheckout
            ? 'Buyer / test checkout'
            : isTrace
              ? 'Buyer / decision trace'
              : 'Buyer agent / Northstar'
        }
        title={
          isCheckout
            ? 'One last confirmation.'
            : isTrace
              ? 'Why this product?'
              : 'Give the agent a job.'
        }
        description={
          isCheckout
            ? 'Review the protocol receipt before committing a test-mode payment.'
            : isTrace
              ? 'A readable record of how Northstar moved from intent to recommendation.'
              : 'Northstar will search the open network, check policy, and return with a recommendation you can explain.'
        }
      />
      {buyerSubpage === 'checkout' && (
        <Checkout
          product={rec}
          approved={approved}
          onApprove={() => setApproved(true)}
          sessionId={sessionId}
          policy={traceResult?.policy ?? null}
          viewer="buyer"
          theme={theme}
        />
      )}
      {buyerSubpage === 'trace' && (
        <Trace
          steps={traceSteps}
          result={traceResult}
          sessionId={sessionId}
          serverSignature={traceEvidence}
          sessionMaxSpend={buyerSession?.maxSpend ?? null}
        />
      )}
      {buyerSubpage === 'console' && (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
          <div className="flex min-h-[520px] flex-col rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-foreground/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--commerce-signal)] text-[var(--commerce-signal-foreground)]">
                  <Bot size={18} />
                </div>
                <div>
                  <p className="text-sm font-bold">Northstar Agent</p>
                  <p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">
                    {loading ? 'thinking…' : 'ready · policy loaded'}
                  </p>
                </div>
              </div>
              <Pill signal>
                <span className="h-1.5 w-1.5 rounded-full bg-current" /> online
              </Pill>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-b border-foreground/10 pb-3 text-xs text-muted-foreground">
              <span className="font-mono-ui text-[9px] uppercase tracking-[.12em]">
                My max this session
              </span>
              <span>$</span>
              <input
                value={maxSpend}
                onChange={(e) => setMaxSpend(e.target.value)}
                type="number"
                min="1"
                className="h-8 w-24 rounded-md border border-foreground/15 bg-background px-2 text-right font-mono-ui text-[10px] outline-none focus:border-[var(--commerce-signal)]"
                data-testid="input-buyer-max-spend"
              />
              <span className="text-[10px] text-muted-foreground/70">
                overrides merchant cap for this session
              </span>
            </div>
            <div className="flex-1 space-y-5 py-7">
              <div className="max-w-[350px] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-6">
                I can search the network for products that fit your policy. What are we looking for?
              </div>
              {submitted && (
                <>
                  <div className="ml-auto max-w-[350px] rounded-2xl rounded-tr-sm bg-foreground px-4 py-3 text-sm leading-6 text-background">
                    {prompt}
                  </div>
                  {loading && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="max-w-[390px] rounded-2xl rounded-tl-sm border border-foreground/10 bg-muted px-4 py-3 text-sm leading-6"
                    >
                      <div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">
                        <Loader2 size={12} className="animate-spin" /> searching network…
                      </div>
                    </motion.div>
                  )}
                  {!loading && error && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="max-w-[390px] rounded-2xl rounded-tl-sm border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm leading-6"
                    >
                      <div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-destructive">
                        <AlertTriangle size={12} /> query failed
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">{error}</p>
                    </motion.div>
                  )}
                  {!loading && !error && traceResult && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="max-w-[390px] rounded-2xl rounded-tl-sm border border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10 px-4 py-3 text-sm leading-6"
                    >
                      <div className="mb-2 flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-foreground">
                        <Sparkles size={12} /> completed{elapsed != null ? ` in ${elapsed}ms` : ''}
                      </div>
                      {rec ? (
                        <>
                          I found <strong>{rec.name}</strong> from {rec.sku}.{' '}
                          {traceResult?.policyResult === 'human_approval_required'
                            ? traceResult?.exceededCeiling === 'buyer' ||
                              traceResult?.exceededCeiling === 'both'
                              ? 'This is above the limit you set — human approval required.'
                              : 'It matches intent but is above the merchant cap — human approval required.'
                            : 'It matches intent and is policy-approved.'}
                          <div className="mt-4 flex gap-2">
                            <Link
                              href="/buyer/trace"
                              className="rounded-md border border-foreground/15 px-2.5 py-1.5 font-mono-ui text-[10px]"
                              data-testid="link-view-trace"
                            >
                              View trace
                            </Link>
                            <Link
                              href="/buyer/checkout"
                              className="rounded-md bg-foreground px-2.5 py-1.5 font-mono-ui text-[10px] text-background"
                              data-testid="link-review-checkout"
                            >
                              Review checkout
                            </Link>
                          </div>
                          {renderUpsellSuggestions({
                            rec,
                            suggestions: traceResult?.suggestions ?? [],
                            sessionId,
                            maxSpend: parseFloat(maxSpend.replace(/[^0-9.]/g, '')) || undefined,
                            dismissed: dismissedSuggestions,
                            setDismissed: setDismissedSuggestions,
                            upsellState,
                            setUpsellState,
                            toast,
                          })}
                        </>
                      ) : (
                        <>
                          No product in the catalog matched all your constraints. Try broadening the
                          search.
                        </>
                      )}
                    </motion.div>
                  )}
                </>
              )}
            </div>
            <div className="border-t border-foreground/10 pt-4">
              <div className="relative">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Ask Northstar to find something…"
                  className="min-h-[76px] w-full resize-none rounded-xl border border-input bg-background p-3 pr-12 text-sm outline-none focus:border-[var(--commerce-signal)]"
                  data-testid="textarea-agent-prompt"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                />
                <button
                  onClick={handleSubmit}
                  className="absolute bottom-3 right-3 grid h-8 w-8 place-items-center rounded-lg bg-foreground text-background disabled:opacity-40"
                  disabled={!prompt.trim() || loading}
                  data-testid="button-send-agent-prompt"
                >
                  <Send size={14} />
                </button>
              </div>
              <button
                onClick={() => {
                  setPrompt(sample);
                  setSubmitted(false);
                  setTraceSteps([]);
                  setTraceResult(null);
                  setTraceEvidence(undefined);
                  setError(null);
                }}
                className="mt-3 font-mono-ui text-[10px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
                data-testid="button-sample-prompt"
              >
                Use sample prompt
              </button>
            </div>
          </div>
          <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
                  Current policy
                </p>
                <h3 className="mt-2 font-display text-xl font-bold">Northstar boundaries</h3>
              </div>
              <ShieldCheck
                size={18}
                className="text-foreground"
              />
            </div>
            <div className="mt-8 space-y-4">
              {[
                ['Maximum spend', '$180.00 USD'],
                ['Delivery window', 'This week'],
                ['Return policy', '30 days minimum'],
                ['Preferred signal', 'Quiet / warm'],
              ].map(([a, b]) => (
                <div
                  key={a}
                  className="flex items-center justify-between border-b border-foreground/10 pb-3 text-xs"
                >
                  <span className="text-muted-foreground">{a}</span>
                  <span className="font-mono-ui text-[10px]">{b}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 rounded-xl bg-muted p-4">
              <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em]">
                <LockKeyhole size={13} /> policy is active
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                The agent cannot purchase outside these boundaries without your approval.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Trace({
  steps,
  result,
  sessionId,
  serverSignature,
  sessionMaxSpend,
}: {
  steps: TraceStep[];
  result: BuyerQueryResult | null;
  sessionId: string | null;
  serverSignature?: string;
  sessionMaxSpend?: number | null;
}) {
  const rec = result?.recommendedProduct;
  const confidence = result?.confidence ?? 0;
  const policyResult = result?.policyResult ?? 'pending';

  // Detect failure/recovery steps for visual styling
  const failureLabels = new Set(['Catalog query failed', 'Retry failed']);
  const recoveryLabels = new Set(['Catalog fallback']);
  const degraded = steps.some((s) => failureLabels.has(s.label));
  const recovered = steps.some((s) => recoveryLabels.has(s.label) || s.detail.includes('cached'));

  const evidenceLines = [
    `decision: ${rec ? 'recommend' : 'no_match'}`,
    `product: ${rec?.sku ?? 'N/A'}`,
    `confidence: ${confidence.toFixed(3)}`,
    `policy_result: ${policyResult}`,
    sessionMaxSpend != null
      ? `session_cap: ₹${Number(sessionMaxSpend).toFixed(2)} (checked alongside merchant cap)`
      : 'session_cap: none (merchant cap only)',
    degraded
      ? `data_source: ${recovered ? 'cached (degraded)' : 'unavailable'}`
      : 'data_source: live',
    '',
    'reasoning:',
    rec ? '  + matches intent keywords' : '  - no products matched enough constraints',
    rec ? '  + price within ceiling' : '',
    policyResult === 'auto_approved'
      ? '  + policy approved'
      : policyResult === 'human_approval_required'
        ? '  ! requires human approval'
        : '  - policy not met',
    recovered ? '  ! used cached catalog data (supplier unreachable)' : '',
    '',
    serverSignature
      ? `signed_evidence: ${serverSignature}`
      : 'signed_evidence: <awaiting server>',
  ]
    .filter(Boolean)
    .join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(evidenceLines).catch(() => {});
  };

  // Helper: determine step visual style
  const stepStyle = (
    label: string,
  ): { borderClass: string; dotClass: string; icon?: ReactNode } => {
    if (failureLabels.has(label))
      return {
        borderClass: 'border-warning/50 bg-warning/5',
        dotClass: 'border-warning/60 bg-warning/15 text-warning',
        icon: <AlertTriangle size={11} />,
      };
    if (recoveryLabels.has(label))
      return {
        borderClass: 'border-positive/40 bg-positive/5',
        dotClass: 'border-positive/50 bg-positive/15 text-positive',
        icon: <RefreshCw size={11} />,
      };
    return {
      borderClass: '',
      dotClass:
        'border-[var(--commerce-signal)]/50 bg-[var(--commerce-signal)]/10 text-foreground',
    };
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
      <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
        <div className="flex items-center justify-between border-b border-foreground/10 pb-5">
          <span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">
            {sessionId ?? 'trace_awaiting'}
          </span>
          <div className="flex items-center gap-2">
            {degraded && (
              <Pill>
                <AlertTriangle size={10} /> degraded
              </Pill>
            )}
            {recovered && !degraded && (
              <Pill signal>
                <RefreshCw size={10} /> recovered
              </Pill>
            )}
            <Pill signal={steps.length > 0 && !degraded}>
              <Check size={11} />{' '}
              {steps.length > 0 ? (degraded ? 'fallback active' : 'explainable') : 'waiting'}
            </Pill>
          </div>
        </div>
        <div className="mt-8 space-y-0">
          {steps.length === 0 && (
            <div className="grid place-items-center py-12 text-center">
              <Loader2 size={22} className="animate-spin text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">Waiting for trace steps…</p>
            </div>
          )}
          {steps.map((step, i) => {
            const style = stepStyle(step.label);
            return (
              <div key={i} className="relative flex gap-4 pb-8 last:pb-0">
                <div
                  className={cn(
                    'relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border',
                    style.dotClass,
                  )}
                >
                  {style.icon ?? i + 1}
                </div>
                {i < steps.length - 1 && (
                  <div className="absolute left-3.5 top-7 h-full w-px bg-foreground/10" />
                )}
                <div className={cn('flex-1 rounded-lg border p-3', style.borderClass)}>
                  <p className="text-sm font-semibold">{step.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
                  <p className="mt-2 font-mono-ui text-[10px] text-muted-foreground">
                    {step.timestamp} UTC
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="rounded-2xl border border-terminal bg-terminal p-6 text-terminal-foreground">
        <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-terminal-muted">
          <Code2 size={14} /> signed evidence
          {degraded && (
            <span className="ml-2 rounded bg-warning/30 px-2 py-0.5 text-warning">
              degraded mode
            </span>
          )}
        </div>
        <pre className="mt-7 whitespace-pre-wrap font-mono-ui text-[10px] leading-6 text-terminal-foreground">
          {evidenceLines}
        </pre>
        <button
          onClick={handleCopy}
          className="mt-8 flex items-center gap-2 rounded-lg border border-terminal px-3 py-2 font-mono-ui text-[10px] text-terminal-muted hover:text-terminal-foreground"
          data-testid="button-copy-evidence"
        >
          <Copy size={13} /> Copy evidence
        </button>
      </div>
    </div>
  );
}

function Checkout({
  product,
  approved,
  onApprove,
  sessionId,
  policy,
  viewer = 'merchant',
  paymentState,
  theme = 'light',
}: {
  product: Product | null | undefined;
  approved: boolean;
  onApprove: () => void;
  sessionId: string | null;
  policy: CheckoutStartPolicy | null;
  viewer?: 'merchant' | 'buyer';
  paymentState?: 'idle' | 'pending_verification' | 'paid' | 'failed';
  theme?: Theme;
}) {
  const name = product?.name ?? '';
  const sku = product?.sku ?? '';
  const price = product?.price ?? 0;
  const seller = product?.sellerId ?? '';
  const needsHuman = policy?.decision === 'human_approval_required';
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<{ title: string; message: ReactNode } | null>(null);

  const [, setLocation] = useLocation();

  const handlePay = async () => {
    if (paying || approved || !product) return;
    setPaying(true);
    setPayError(null);
    try {
      // 1. Server-authoritative basket: amount is recalculated from DB.
      const workspaceId = getOrCreateBuyerWorkspaceId();
      const basket = await createBasket(workspaceId, product.id);
      // 2. Start checkout → server runs policy. When policy.requiresHumanApproval
      // is true, the server returns 200 with the order in pending_human_review
      // and NO razorpayOrderId. The user MUST click Approve which calls the
      // dedicated /api/checkout/human-approve/:orderId route to mint the
      // Razorpay order. Inline `approved` body field is rejected by the
      // server.
      let checkout: CheckoutStartResponse = await startCheckout({
        basketId: basket.id,
        workspaceId,
      });
      if (checkout.requiresHumanApproval) {
        // User has clicked "Confirm manual override" → call the dedicated
        // route. This flips status to human_approved and mints the
        // Razorpay order id.
        const approvedRes = await humanApproveCheckout(checkout.orderId);
        checkout = {
          ...checkout,
          razorpayOrderId: approvedRes.razorpayOrderId,
          keyId: approvedRes.keyId ?? checkout.keyId,
        };
      }
      if (!checkout.razorpayOrderId) {
        setPaying(false);
        setPayError({
          title: 'Checkout is awaiting approval',
          message: 'The policy engine required a manual override that could not be recorded. Try again or contact support.',
        });
        return;
      }
      // 3. Open the real Razorpay checkout modal with server-issued order.
      const rzp = new window.Razorpay({
        key: checkout.keyId,
        order_id: checkout.razorpayOrderId,
        amount: checkout.amount,
        currency: checkout.currency,
        name: 'Commerce0S',
        description: `Test payment — ${name}`,
        handler: async (_response) => {
          // Payment modal closed successfully — webhook may still be in
          // flight. We poll the server's order state and only mark approved
          // when the DB reflects 'paid'. Timeouts stay in pending state
          // rather than faking success.
          let attempts = 0;
          const maxAttempts = 10;
          while (attempts < maxAttempts) {
            try {
              const verified = await verifyOrder(checkout.orderId, workspaceId);
              if (verified.status === 'paid') {
                setPaying(false);
                onApprove();
                return;
              }
              if (verified.status === 'failed' || verified.status === 'declined') {
                setPaying(false);
                setPayError({
                  title: 'Payment failed',
                  message:
                    "The payment provider rejected this transaction. Check the order's audit row for the reason.",
                });
                return;
              }
            } catch {
              // Network blip; keep polling.
            }
            await new Promise((r) => setTimeout(r, 1000));
            attempts++;
          }
          // Polling exhausted without confirmation. Stay truthful.
          setPaying(false);
          setPayError({
            title: 'Payment verification is still pending',
            message:
              'Razorpay accepted the payment but our webhook has not confirmed it yet. Do not retry payment until status is confirmed — this screen will update when the webhook arrives.',
          });
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
            setPayError({
              title: 'Payment not completed',
              message:
                'You closed the payment window before finishing. You can try again when ready.',
            });
          },
        },
        prefill: { email: 'test@commerce0s.demo' },
        theme: { color: theme === 'dark' ? '#F06A5D' : '#A7342E' },
      });
      rzp.open();
    } catch (err) {
      setPaying(false);
      setPayError(mapCheckoutError(err, viewer, setLocation));
    }
  };

  if (!product) {
    return (
      <div className="rounded-2xl border border-foreground/10 bg-card p-8 text-center">
        <Package size={26} className="mx-auto text-muted-foreground" />
        <p className="mt-3 font-display text-lg font-semibold">Pick a product first</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Run a buyer query on the Agent Console and accept a recommendation before checking out.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_.75fr]">
      <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted">
            <Package size={21} />
          </div>
          <div>
            <p className="font-display text-xl font-bold">{name}</p>
            <p className="font-mono-ui text-[10px] text-muted-foreground">
              {sku} · {seller}
            </p>
          </div>
        </div>
        <div className="mt-8 space-y-4 border-t border-foreground/10 pt-5 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Item</span>
            <span>₹{price.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Test-mode delivery</span>
            <span>₹0.00</span>
          </div>
          <div className="flex justify-between border-t border-foreground/10 pt-4 font-semibold">
            <span>Total</span>
            <span>₹{price.toFixed(2)} INR</span>
          </div>
        </div>
        {paymentState && paymentState !== 'idle' && (
          <div
            className={cn(
              'mt-6 flex items-center gap-2 rounded-xl border p-3 font-mono-ui text-[10px]',
              paymentState === 'paid'
                ? 'border-positive/40 bg-positive/5 text-positive'
                : paymentState === 'pending_verification'
                  ? 'border-warning/40 bg-warning/5 text-warning'
                  : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
            data-testid="checkout-payment-state"
          >
            {paymentState === 'paid' ? <Check size={12} /> : <Loader2 size={12} className="animate-spin" />}
            {paymentState === 'paid'
              ? 'Payment confirmed by Razorpay webhook'
              : paymentState === 'pending_verification'
                ? 'Verification pending — waiting for Razorpay webhook'
                : 'Payment failed'}
          </div>
        )}
        {/* Policy check card — branches on real backend result */}
        {needsHuman ? (
          <div className="mt-8 rounded-xl border border-warning/40 bg-warning/5 p-4">
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-warning">
              <AlertTriangle size={14} /> above auto-approve limit
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              This item exceeds your max auto-approve setting. Confirm to proceed with a manual
              override.
            </p>
          </div>
        ) : policy ? (
          <div className="mt-8 rounded-xl border border-[var(--commerce-signal)]/40 bg-[var(--commerce-signal)]/10 p-4">
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-foreground">
              <ShieldCheck size={14} /> policy check passed
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Within spending cap · delivery verified · seller trusted
            </p>
          </div>
        ) : null}
        {/* Error state */}
        {payError && (
          <div
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
            data-testid="checkout-error"
          >
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-destructive">
              <AlertTriangle size={14} /> {payError.title}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{payError.message}</p>
          </div>
        )}
        <Button
          onClick={handlePay}
          disabled={approved || paying || paymentState === 'pending_verification'}
          className="mt-6 h-12 w-full rounded-lg bg-foreground text-background disabled:opacity-100"
          data-testid="button-approve-checkout"
        >
          {paying ? (
            <>
              <Loader2 size={16} className="mr-2 animate-spin" /> Opening Razorpay…
            </>
          ) : paymentState === 'pending_verification' ? (
            <>
              <Loader2 size={16} className="mr-2 animate-spin" /> Awaiting webhook…
            </>
          ) : approved ? (
            <>
              <Check size={16} className="mr-2 text-[var(--commerce-signal)]" />{' '}
              {needsHuman ? 'Manual override recorded' : 'Test payment authorized'}
            </>
          ) : needsHuman ? (
            <>
              <AlertTriangle size={16} className="mr-2" /> Confirm manual override
            </>
          ) : (
            <>
              <CreditCard size={16} className="mr-2" /> Approve test payment
            </>
          )}
        </Button>
        <p className="mt-3 text-center font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">
          Test / reversible · no real funds moved
        </p>
      </div>
      <div className="space-y-4">
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-bold">Policy decision</h3>
            <ShieldCheck size={18} className="text-muted-foreground" />
          </div>
          <div className="mt-5">
            <PolicyDecisionCard policy={policy} amount={price} />
          </div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-xl font-bold">Protocol receipt</h3>
            <FileText size={18} className="text-muted-foreground" />
          </div>
          <div className="mt-7 space-y-5 font-mono-ui text-[10px]">
            <div>
              <p className="text-muted-foreground">PAYMENT MODE</p>
              <p className="mt-1 text-foreground">
                TEST / REVERSIBLE
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">AUTHORIZATION</p>
              <p className="mt-1">
                {approved
                  ? 'approved_by_northstar'
                  : paying
                    ? 'razorpay_checkout_open'
                    : 'awaiting_approval'}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">SESSION ID</p>
              <p className="mt-1">{sessionId ?? 'pending'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">SETTLEMENT</p>
              <p className="mt-1">
                {paymentState === 'paid'
                  ? 'ledger.test / recorded'
                  : paymentState === 'pending_verification'
                    ? 'awaiting webhook'
                    : paying
                      ? 'processing'
                      : 'not initiated'}
              </p>
            </div>
          </div>
          {approved && paymentState === 'paid' && (
            <div className="mt-10 rounded-lg bg-muted p-3 text-xs leading-5">
              <Check
                size={14}
                className="mb-2 text-foreground"
              />
              Receipt recorded. No real funds moved.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Translate a thrown error from the checkout flow into a human message
 * keyed to the backend's error code. Buyer-facing copy hides configuration
 * details; merchant-facing copy can direct them to Settings.
 */
function mapCheckoutError(
  err: unknown,
  viewer: 'merchant' | 'buyer',
  navigate: (path: string) => void,
): { title: string; message: ReactNode } {
  if (err instanceof NetworkUnreachableError) {
    return {
      title: "Can't reach the server",
      message: 'Check your connection and try again in a moment.',
    };
  }
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'RAZORPAY_NOT_CONFIGURED':
        if (viewer === 'merchant') {
          return {
            title: 'Payment gateway not configured',
            message: (
              <>
                Add your Razorpay test keys in{' '}
                <button
                  type="button"
                  onClick={() => navigate('/merchant/settings#payment-gateway')}
                  className="font-semibold text-foreground underline underline-offset-2"
                >
                  Settings → Payment gateway
                </button>
                .
              </>
            ),
          };
        }
        return {
          title: 'Payments are paused',
          message:
            "This merchant hasn't connected a payment gateway yet. Please try again later or notify the merchant.",
        };
      case 'RAZORPAY_AUTH_FAILED':
        if (viewer === 'merchant') {
          return {
            title: 'Razorpay rejected your keys',
            message: (
              <>
                Check the key pair in{' '}
                <button
                  type="button"
                  onClick={() => navigate('/merchant/settings#payment-gateway')}
                  className="font-semibold text-foreground underline underline-offset-2"
                >
                  Settings → Payment gateway
                </button>
                .
              </>
            ),
          };
        }
        return {
          title: 'Payment temporarily unavailable',
          message: 'Please try again shortly.',
        };
      case 'RAZORPAY_REQUEST_FAILED':
        return {
          title: 'Payment provider is temporarily unreachable',
          message: 'This is usually resolved within a few minutes — you can retry now.',
        };
      case 'ORDER_CREATE_FAILED':
        return {
          title: "Couldn't start payment",
          message:
            'Something went wrong on our side. Please try again, or contact support if it persists.',
        };
      case 'HUMAN_APPROVAL_REQUIRED':
        return {
          title: 'Approval required',
          message:
            'This purchase is above your session spending limit or the merchant cap. Review the policy card and confirm to continue.',
        };
      case 'MERCHANT_CEILING_EXCEEDED':
      case 'BUYER_CEILING_EXCEEDED':
      case 'BOTH_CEILINGS_EXCEEDED':
        return {
          title: 'Above spending limit',
          message: err.message || 'This basket exceeds a configured ceiling and needs approval.',
        };
      case 'PAYMENT_VERIFICATION_PENDING':
        return {
          title: 'Payment verification is still pending',
          message:
            'Do not retry payment until status is confirmed. We will update this screen when the webhook arrives.',
        };
      case 'INVENTORY_UNAVAILABLE':
        return {
          title: 'Out of stock',
          message: err.message || 'One of the items is no longer available.',
        };
      case 'INVALID_REQUEST':
        return {
          title: 'Invalid request',
          message: err.message,
        };
      default:
        return {
          title: "Couldn't start payment",
          message: err.message || 'Please try again, or contact support if it persists.',
        };
    }
  }
  return {
    title: "Couldn't start payment",
    message: 'An unexpected error occurred. Please try again.',
  };
}

// ── Shell & Router ──────────────────────────────────────────────────────────

function MerchantShell({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const { toast } = useToast();
  const { data: debugStatus } = useQuery<DebugStatus>({
    queryKey: ['debug-status'],
    queryFn: fetchDebugStatus,
    refetchInterval: 3000,
  });
  const page = location.replace(/\/$/, '') || '/merchant';
  const view =
    page === '/merchant/catalog' ? (
      <Catalog />
    ) : page === '/merchant/orders' ? (
      <Orders />
    ) : page === '/merchant/activity' ? (
      <ActivityPage />
    ) : page === '/merchant/audit' ? (
      <ActivityPage audit />
    ) : page === '/merchant/settings' ? (
      <Settings />
    ) : (
      <MerchantOverview />
    );
  const simulating = debugStatus?.simulateSupplierFailure ?? false;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <Sidebar
        role="merchant"
        page={page}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((v) => !v)}
        onToggle={onToggle}
      />
      <MobileNav role="merchant" open={mobile} onClose={() => setMobile(false)} />
      <div
        className={cn(
          'min-h-[100dvh] transition-all',
          collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]',
        )}
      >
        <Topbar
          role="merchant"
          theme={theme}
          onToggle={onToggle}
          onMobileMenu={() => setMobile(true)}
        />
        <div className="border-b border-foreground/10 bg-warning-soft px-4 py-2 sm:px-7">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1 font-mono-ui text-[10px]',
                  simulating
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : 'border-positive/40 bg-positive/10 text-positive',
                )}
                data-testid="supplier-status-indicator"
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    simulating ? 'bg-warning' : 'bg-positive',
                  )}
                />
                {simulating ? 'Supplier: simulated outage' : 'Supplier: healthy'}
              </span>
              <span className="font-mono-ui text-[10px] text-muted-foreground">
                demo control lives in Settings
              </span>
            </div>
            <a
              href="/merchant/settings"
              className="inline-flex items-center gap-2 rounded-lg border border-foreground/20 px-3 py-1.5 font-mono-ui text-[10px] hover:bg-foreground/[.06]"
              data-testid="link-settings-from-topbar"
            >
              <Radio size={12} /> Open settings
            </a>
          </div>
        </div>
        <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-7 sm:py-10 lg:px-10">{view}</main>
      </div>
    </div>
  );
}

function BuyerShell({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const page = location.replace(/\/$/, '') || '/buyer';
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <Sidebar
        role="buyer"
        page={page}
        collapsed={collapsed}
        onCollapse={() => setCollapsed((v) => !v)}
        onToggle={onToggle}
      />
      <MobileNav role="buyer" open={mobile} onClose={() => setMobile(false)} />
      <div
        className={cn(
          'min-h-[100dvh] transition-all',
          collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]',
        )}
      >
        <Topbar
          role="buyer"
          theme={theme}
          onToggle={onToggle}
          onMobileMenu={() => setMobile(true)}
        />
        <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-7 sm:py-10 lg:px-10">
          <BuyerConsole subpage={page} theme={theme} />
        </main>
      </div>
    </div>
  );
}

function AppRouter({
  theme,
  onToggle,
  onChooseRole,
}: {
  theme: Theme;
  onToggle: () => void;
  onChooseRole: (role: Role) => void;
}) {
  return (
    <Switch>
      <Route path="/auth">
        <Auth onChooseRole={onChooseRole} theme={theme} onToggle={onToggle} />
      </Route>
      <Route path="/merchant/:page*">
        <MerchantShell theme={theme} onToggle={onToggle} />
      </Route>
      <Route path="/merchant">
        <MerchantShell theme={theme} onToggle={onToggle} />
      </Route>
      <Route path="/buyer/:page*">
        <BuyerShell theme={theme} onToggle={onToggle} />
      </Route>
      <Route path="/buyer">
        <BuyerShell theme={theme} onToggle={onToggle} />
      </Route>
      <Route path="/">
        <Landing theme={theme} onToggle={onToggle} />
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function TransactionDrawerMount() {
  const [txn, setTxn] = useOpenTransaction();
  return <TransactionDetailDrawer txnId={txn} onClose={() => setTxn(null)} />;
}

function App() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('commerce0s-theme') as Theme) || 'light',
  );
  const [, setLocation] = useLocation();
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('commerce0s-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme((v) => (v === 'light' ? 'dark' : 'light'));
  const chooseRole = (role: Role) => setLocation(role === 'merchant' ? '/merchant' : '/buyer');
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WorkspaceProvider>
          <BootstrapErrorBridge />
          <ErrorBoundary resetKey={location}>
            <AppRouter theme={theme} onToggle={toggleTheme} onChooseRole={chooseRole} />
          </ErrorBoundary>
          <TransactionDrawerMount />
        </WorkspaceProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** Surfaces bootstrap failures via the existing toast system without blocking
 *  the rest of the UI. Retries are user-initiated from the toast action. */
function BootstrapErrorBridge() {
  const { status, error, retry } = useWorkspace();
  const { toast } = useToast();
  useEffect(() => {
    if (status !== 'error' || !error) return;
    toast({
      title: 'Workspace sync paused',
      description: error,
      variant: 'destructive',
      action: <button onClick={retry} className="font-mono-ui text-[10px] uppercase tracking-[.12em]">Retry</button>,
    });
    // Only fire on the error transition, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, error]);
  return null;
}

export default App;
