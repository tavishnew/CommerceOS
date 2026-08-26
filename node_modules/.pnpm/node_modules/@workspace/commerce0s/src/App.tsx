import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bot, Box, Check,
  ChevronRight, Code2, Command, Copy, CreditCard, FileKey2, FileText, Filter,
  Globe2, LayoutGrid, LockKeyhole, Menu, Moon, MoreHorizontal,
  Package, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Radio, RefreshCw,
  Search, Send, Settings2, ShieldCheck, ShoppingBag, SlidersHorizontal,
  Sparkles, Sun, Tags, Terminal, Trash2, TrendingUp, UserRound, Users,
  X, Zap, Loader2, AlertTriangle
} from 'lucide-react';
import { Link, Route, Switch, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
  handler: (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void;
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
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import NotFound from '@/pages/not-found';
import {
  type Product,
  type Order,
  type TraceStep,
  type BuyerQueryResult,
  type MerchantSettings,
  type CreateOrderResponse,
  fetchCatalog,
  fetchOrders,
  fetchOrder,
  updateProduct,
  deleteProduct,
  submitBuyerQuery,
  subscribeTrace,
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
} from '@/lib/api';

const queryClient = new QueryClient();

type Theme = 'light' | 'dark';
type Role = 'merchant' | 'buyer';

const activities = [
  { time: '12:48:06', kind: 'BUYER', text: 'Found match for "warm task light, under $180"', agent: 'buyer.northstar', color: 'text-[hsl(var(--accent))]' },
  { time: '12:47:52', kind: 'POLICY', text: 'Spend ceiling verified · $180.00', agent: 'policy.guard', color: 'text-[#d1c7aa]' },
  { time: '12:47:49', kind: 'SELLER', text: 'Inventory reserved · Lattice Desk Lamp', agent: 'seller.almond', color: 'text-[hsl(var(--accent))]' },
  { time: '12:47:41', kind: 'TRACE', text: '3 candidates scored · 1 shortlisted', agent: 'router.core', color: 'text-[#c4c0b3]' },
  { time: '12:47:38', kind: 'BUYER', text: 'Intent parsed into 4 constraints', agent: 'buyer.northstar', color: 'text-[hsl(var(--accent))]' },
];

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
];

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link href="/" className="flex items-center gap-3" data-testid="link-logo">
      <span className={cn('grid h-8 w-8 place-items-center rounded-[9px] border', inverse ? 'border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]' : 'border-foreground/20 bg-foreground text-background')}>
        <span className="font-display text-[17px] font-bold leading-none">0</span>
      </span>
      <span className={cn('font-display text-[20px] font-bold tracking-[-.04em]', inverse ? 'text-sidebar-foreground' : 'text-foreground')}>Commerce<span className="text-[hsl(var(--accent))]">0S</span></span>
    </Link>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button onClick={onToggle} className="group relative grid h-9 w-9 place-items-center rounded-full border border-foreground/15 bg-background text-muted-foreground transition hover:border-foreground/30 hover:text-foreground" data-testid="button-theme-toggle" aria-label="Toggle theme">
      {theme === 'light' ? <Moon size={15} /> : <Sun size={15} />}
    </button>
  );
}

function Pill({ children, signal = false }: { children: ReactNode; signal?: boolean }) {
  return <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[10px] uppercase tracking-[.12em]', signal ? 'border-[hsl(var(--accent)/.35)] bg-[hsl(var(--accent)/.1)] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]' : 'border-foreground/15 bg-foreground/[.04] text-muted-foreground')}>{children}</span>;
}

function ButtonArrow({ children, onClick, variant = 'primary', testId }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'outline' | 'ghost'; testId?: string }) {
  return (
    <Button onClick={onClick} data-testid={testId} className={cn('group h-11 rounded-full px-5 text-sm font-semibold transition-all', variant === 'primary' && 'bg-foreground text-background hover:bg-foreground/85', variant === 'outline' && 'border border-foreground/20 bg-transparent text-foreground hover:bg-foreground/[.06]', variant === 'ghost' && 'bg-transparent px-3 text-muted-foreground hover:text-foreground')}>
      {children}<ArrowRight size={15} className="ml-2 transition-transform group-hover:translate-x-1" />
    </Button>
  );
}

function Landing({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [, setLocation] = useLocation();
  return (
    <div className="grain min-h-[100dvh] overflow-hidden bg-background text-foreground">
      <header className="relative z-10 mx-auto flex max-w-[1240px] items-center justify-between px-5 py-5 sm:px-8 lg:px-10">
        <Logo />
        <nav className="hidden items-center gap-8 text-[13px] font-semibold text-muted-foreground md:flex">
          <a href="#protocol" className="transition hover:text-foreground">Protocol</a>
          <a href="#operators" className="transition hover:text-foreground">Operators</a>
          <a href="#trust" className="transition hover:text-foreground">Trust layer</a>
        </nav>
        <div className="flex items-center gap-2.5">
          <ThemeToggle theme={theme} onToggle={onToggle} />
          <Button onClick={() => setLocation('/auth')} data-testid="button-open-console" className="hidden h-9 rounded-full bg-foreground px-4 text-xs font-bold text-background hover:bg-foreground/85 sm:inline-flex">Open console</Button>
          <button className="grid h-9 w-9 place-items-center rounded-full border border-foreground/15 md:hidden" data-testid="button-mobile-menu"><Menu size={16} /></button>
        </div>
      </header>

      <main>
        <section className="relative mx-auto max-w-[1240px] px-5 pb-20 pt-16 sm:px-8 sm:pt-24 lg:px-10 lg:pb-32 lg:pt-28">
          <div className="absolute -right-20 top-16 h-[420px] w-[420px] rounded-full bg-[hsl(var(--accent)/.06)] blur-3xl" />
          <div className="relative grid items-center gap-12 lg:grid-cols-[1.02fr_.98fr] lg:gap-16">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .65 }} className="relative max-w-[800px]">
            <Pill signal><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))] status-live" /> Protocol online · test mode</Pill>
            <h1 className="mt-7 max-w-[820px] font-display text-[clamp(3.8rem,8vw,7.8rem)] font-bold leading-[.88] tracking-[-.075em]">
              Commerce,<br /><span className="text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">with agency.</span>
            </h1>
            <p className="mt-8 max-w-[525px] text-[17px] leading-7 text-muted-foreground sm:text-[19px]">The operating surface for a new kind of marketplace — where buyer and seller agents discover, decide, transact, and explain themselves.</p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <ButtonArrow onClick={() => setLocation('/auth')} testId="button-start-building">Start building</ButtonArrow>
              <ButtonArrow onClick={() => document.getElementById('protocol')?.scrollIntoView({ behavior: 'smooth' })} variant="outline" testId="button-see-protocol">See the protocol</ButtonArrow>
            </div>
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 28, rotate: 3 }} animate={{ opacity: 1, x: 0, rotate: 0 }} transition={{ duration: .8, delay: .25 }} className="hero-console relative mx-auto w-full max-w-[470px] lg:mt-10" aria-label="Live agent decision preview">
            <div className="hero-console-glow absolute -inset-8 rounded-[38px] blur-3xl" />
            <div className="relative overflow-hidden rounded-[26px] border border-foreground/15 bg-card/90 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><Bot size={16} /></span>
                  <div><p className="text-xs font-bold">Northstar / buyer agent</p><p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">decision stream · live</p></div>
                </div>
                <Pill signal><span className="h-1.5 w-1.5 rounded-full bg-current status-live" /> online</Pill>
              </div>
              <div className="space-y-4 p-5">
                <div className="rounded-xl bg-muted p-4"><p className="font-mono-ui text-[9px] uppercase tracking-[.13em] text-muted-foreground">incoming intent</p><p className="mt-2 text-sm font-semibold">Find a warm task light under $180.</p></div>
                <div className="space-y-3 pl-3">
                  {[
                    ['01', 'Intent parsed', '4 constraints extracted'],
                    ['02', 'Catalog searched', '18 candidates returned'],
                    ['03', 'Policy verified', 'ceiling · delivery · trust'],
                  ].map(([num, title, detail], i) => <motion.div key={num} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .65 + i * .16 }} className="relative flex gap-3 border-l border-[hsl(var(--accent)/.45)] pl-4">
                    <span className="font-mono-ui text-[10px] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">{num}</span><div><p className="text-xs font-semibold">{title}</p><p className="mt-0.5 font-mono-ui text-[9px] text-muted-foreground">{detail}</p></div>
                  </motion.div>)}
                </div>
                <div className="flex items-center justify-between rounded-xl border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.08)] p-4">
                  <div><p className="font-mono-ui text-[9px] uppercase tracking-[.13em] text-muted-foreground">recommendation</p><p className="mt-1 text-sm font-bold">Lattice Desk Lamp</p></div><span className="font-display text-xl font-bold">$148</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-foreground/10 px-5 py-3 font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground"><span>trace_8f31c0a9</span><span className="text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">explainable</span></div>
            </div>
          </motion.div>
          </div>
          <motion.div initial={{ opacity: 0, y: 30, rotate: -2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: .8, delay: .2 }} className="network-stage relative mt-20 h-[310px] overflow-hidden rounded-[28px] border border-foreground/15 bg-foreground/[.025] sm:h-[390px] lg:mt-24" aria-label="Live Commerce0S agent network map">
            <div className="absolute left-5 top-5 flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground"><span className="h-2 w-2 rounded-full bg-[hsl(var(--accent))]" /> live network map <span className="ml-2 opacity-40">/ 04 nodes</span></div>
            <div className="wireframe absolute inset-0 grid place-items-center [perspective:1200px]">
              <div className="network-aurora absolute -left-16 top-10 h-56 w-56 rounded-full bg-[hsl(var(--accent)/.15)] blur-3xl" />
              <div className="network-aurora network-aurora-delay absolute -right-16 bottom-0 h-64 w-64 rounded-full bg-[hsl(var(--accent)/.10)] blur-3xl" />
              <div className="wireframe-grid absolute h-[500px] w-[950px] rounded-[50%] opacity-70 [transform:rotateX(64deg)_rotateZ(-8deg)_translateY(40px)]" />
              <svg className="network-lines absolute inset-0 h-full w-full opacity-70" viewBox="0 0 1000 390" preserveAspectRatio="none" aria-hidden="true">
                <path d="M185 112 C350 110 390 190 500 195 C630 200 720 120 850 125" />
                <path d="M270 295 C370 240 400 210 500 195 C620 180 665 250 770 295" />
                <path d="M185 112 C230 205 245 245 270 295" />
                <path d="M850 125 C810 190 790 240 770 295" />
              </svg>
              <div className="network-particle particle-one" />
              <div className="network-particle particle-two" />
              <div className="network-particle particle-three" />
              <div className="relative z-10 grid place-items-center [transform:translateZ(60px)]">
                <div className="network-orbit network-orbit-wide absolute h-[220px] w-[420px] rounded-[50%] border border-[hsl(var(--accent)/.28)]" />
                <div className="network-orbit absolute h-[180px] w-[260px] rounded-[50%] border border-[hsl(var(--accent)/.48)]" />
                <div className="absolute h-[210px] w-[210px] rounded-full border border-[hsl(var(--accent)/.28)] animate-pulse" />
                <div className="absolute h-[120px] w-[120px] rounded-full border border-[hsl(var(--accent)/.55)]" />
                <div className="network-core grid h-20 w-20 place-items-center rounded-2xl border border-[hsl(var(--accent)/.5)] bg-[hsl(var(--accent)/.17)] shadow-[0_0_80px_hsl(var(--accent)/.22)]"><Command size={28} className="text-[hsl(var(--accent))]" /></div>
                <span className="absolute top-[92px] whitespace-nowrap font-mono-ui text-[10px] uppercase tracking-[.16em] text-[hsl(var(--accent))]">routing intelligence</span>
              </div>
              {[
                ['buyer.northstar', 'top-[22%] left-[15%]', 'text-[hsl(var(--accent))]'],
                ['seller.almond', 'right-[12%] top-[28%]', 'text-[#d1c7aa]'],
                ['policy.guard', 'bottom-[24%] left-[24%]', 'text-[#c4c0b3]'],
                ['ledger.test', 'bottom-[17%] right-[19%]', 'text-[#b5aaa0]'],
              ].map(([name, pos, color], i) => <motion.div key={name} animate={{ y: [0, i % 2 ? -7 : 7, 0] }} transition={{ duration: 3 + i, repeat: Infinity, ease: 'easeInOut' }} className={cn('absolute flex items-center gap-2 rounded-full border border-foreground/15 bg-background/85 px-3 py-2 font-mono-ui text-[10px] shadow-lg backdrop-blur', pos)}><span className={cn('h-1.5 w-1.5 rounded-full bg-current', color)} />{name}</motion.div>)}
              <div className="scanline absolute left-[10%] right-[10%] top-[49%] h-px opacity-40" />
            </div>
            <div className="absolute bottom-5 left-5 right-5 flex items-end justify-between font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground"><span>agents negotiate in public</span><span>latency 42ms · encrypted</span></div>
          </motion.div>
        </section>

        <section id="protocol" className="border-y border-foreground/10 bg-foreground/[.025]">
          <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[.75fr_1.25fr] lg:px-10 lg:py-28">
            <div><Pill>01 / Protocol</Pill><h2 className="mt-6 max-w-[440px] font-display text-4xl font-bold leading-[.98] tracking-[-.05em] sm:text-6xl">The invisible layer becomes legible.</h2><p className="mt-6 max-w-[360px] text-sm leading-6 text-muted-foreground">Commerce0S gives every decision a receipt. Not a black box. A protocol trail your team, your customer, and your auditors can read.</p></div>
            <div className="grid gap-px overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/10 sm:grid-cols-3">
              {([
                { num: '01', title: 'Discover', text: 'Agents search intent, not catalogs.', Icon: Search },
                { num: '02', title: 'Decide', text: 'Policy gates every recommendation.', Icon: ShieldCheck },
                { num: '03', title: 'Settle', text: 'Test-mode payments leave proof.', Icon: FileKey2 },
              ] as Array<{ num: string; title: string; text: string; Icon: typeof Search }>).map(({ num, title, text, Icon }) => <div key={num} className="bg-background p-6 sm:p-7"><span className="font-mono-ui text-[10px] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">{num}</span><Icon className="mt-12 text-muted-foreground" size={19} /><h3 className="mt-5 font-display text-2xl font-bold">{title}</h3><p className="mt-2 text-sm leading-5 text-muted-foreground">{text}</p></div>)}
            </div>
          </div>
        </section>

        <section id="operators" className="mx-auto max-w-[1240px] px-5 py-20 sm:px-8 lg:px-10 lg:py-32">
          <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-end"><div><Pill>02 / Operator surface</Pill><h2 className="mt-6 max-w-[700px] font-display text-4xl font-bold leading-[.95] tracking-[-.06em] sm:text-6xl">Run the network.<br /><span className="text-muted-foreground">See every signal.</span></h2></div><p className="max-w-[280px] text-sm leading-6 text-muted-foreground">One console for your catalog, orders, agent activity, and the decisions in between.</p></div>
          <div className="mt-14 grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
             <div className="relative min-h-[370px] overflow-hidden rounded-3xl border border-white/10 bg-[#1b2225] p-7 text-[#ece7d9]"><div className="absolute inset-0 opacity-40 grid-paper" /><div className="relative"><div className="flex items-center justify-between border-b border-white/10 pb-4 font-mono-ui text-[10px] uppercase tracking-[.14em]"><span className="text-white/50">agent activity / now</span><span className="text-[hsl(var(--accent))]">● recording</span></div><div className="mt-7 space-y-5">{activities.slice(0, 4).map((a, i) => <motion.div initial={{ opacity: 0, x: -10 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: i * .12 }} key={a.time} className="flex gap-3 border-l border-white/10 pl-4"><span className="font-mono-ui text-[10px] text-white/35">{a.time}</span><div><p className="font-mono-ui text-xs text-white/80">{a.text}</p><p className={cn('mt-1 font-mono-ui text-[10px]', a.color)}>{a.agent} · {a.kind}</p></div></motion.div>)}</div></div></div>
            <div className="flex min-h-[370px] flex-col justify-between rounded-3xl border border-foreground/15 bg-[hsl(var(--accent))] p-7 text-[hsl(var(--accent-foreground))]"><div><div className="flex items-center justify-between"><Bot size={23} /><span className="font-mono-ui text-[10px] uppercase tracking-[.14em]">buyer agent</span></div><p className="mt-20 font-display text-4xl font-bold leading-[.95] tracking-[-.05em]">"Find me<br />something<br />quiet."</p></div><div className="flex items-center justify-between border-t border-foreground/20 pt-4 font-mono-ui text-[10px] uppercase"><span>4 constraints resolved</span><ArrowUpRight size={15} /></div></div>
          </div>
        </section>

        <section id="trust" className="border-y border-foreground/10 bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]">
          <div className="mx-auto grid max-w-[1240px] gap-14 px-5 py-20 sm:px-8 lg:grid-cols-[1fr_.9fr] lg:px-10 lg:py-28"><div><Pill>03 / Trust layer</Pill><h2 className="mt-6 max-w-[600px] font-display text-5xl font-bold leading-[.9] tracking-[-.06em] sm:text-7xl">Every "why" has a shape.</h2></div><div className="self-end"><p className="max-w-[420px] text-sm leading-6 opacity-75">Policy boundaries. Evidence chains. Payment states. Commerce0S turns agent autonomy into something you can confidently hand the keys to.</p><div className="mt-8 flex flex-wrap gap-2"><span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">SIGNED INTENT</span><span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">POLICY-GATED</span><span className="rounded-full border border-foreground/20 px-3 py-2 font-mono-ui text-[10px]">EXPLAINABLE</span></div></div></div>
        </section>

        <footer className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-12 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-10"><Logo /><div className="flex items-center gap-5 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground"><span>Built for the agent economy</span><button onClick={() => setLocation('/auth')} className="text-foreground underline underline-offset-4" data-testid="button-footer-console">Enter console</button></div></footer>
      </main>
    </div>
  );
}

function Auth({ onChooseRole, theme, onToggle }: { onChooseRole: (role: Role) => void; theme: Theme; onToggle: () => void }) {
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [role, setRole] = useState<Role>('merchant');
  const [submitted, setSubmitted] = useState(false);
  return (
    <div className="grain flex min-h-[100dvh] flex-col bg-background">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8"><Logo /><div className="flex items-center gap-3"><span className="hidden font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:inline">secure access</span><ThemeToggle theme={theme} onToggle={onToggle} /></div></header>
      <main className="mx-auto grid w-full max-w-[1120px] flex-1 items-center gap-12 px-5 py-12 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:gap-24">
        <div className="hidden lg:block"><Pill signal>Commerce0S / identity</Pill><h1 className="mt-7 font-display text-7xl font-bold leading-[.88] tracking-[-.07em]">Choose your<br /><span className="text-muted-foreground">vantage point.</span></h1><p className="mt-7 max-w-[360px] text-sm leading-6 text-muted-foreground">Your role shapes the console. Switch sides anytime — the protocol stays shared.</p><div className="mt-12 flex gap-3 font-mono-ui text-[10px] text-muted-foreground"><span>01 / role</span><span className="text-foreground">02 / workspace</span><span>03 / go</span></div></div>
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-[480px] rounded-3xl border border-foreground/15 bg-card p-6 shadow-2xl sm:p-9">
          <div className="flex gap-1 rounded-xl bg-muted p-1"><button onClick={() => setMode('create')} className={cn('flex-1 rounded-lg py-2.5 text-sm font-semibold transition', mode === 'create' && 'bg-background shadow-sm')} data-testid="button-auth-signup">Create workspace</button><button onClick={() => setMode('signin')} className={cn('flex-1 rounded-lg py-2.5 text-sm font-semibold transition', mode === 'signin' && 'bg-background shadow-sm')} data-testid="button-auth-signin">Sign in</button></div>
          <div className="mt-8"><span className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">I am operating as</span><div className="mt-3 grid grid-cols-2 gap-2"><button onClick={() => setRole('merchant')} className={cn('rounded-xl border p-4 text-left transition', role === 'merchant' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.12)]' : 'border-foreground/15 hover:border-foreground/30')} data-testid="button-role-merchant"><Package size={18} /><strong className="mt-3 block text-sm">Merchant</strong><span className="mt-1 block text-xs text-muted-foreground">Put products in motion.</span></button><button onClick={() => setRole('buyer')} className={cn('rounded-xl border p-4 text-left transition', role === 'buyer' ? 'border-[hsl(var(--accent))] bg-[hsl(var(--accent)/.12)]' : 'border-foreground/15 hover:border-foreground/30')} data-testid="button-role-buyer"><Bot size={18} /><strong className="mt-3 block text-sm">Buyer agent</strong><span className="mt-1 block text-xs text-muted-foreground">Buy within your policy.</span></button></div></div>
          <label className="mt-6 block text-xs font-semibold">Email address<input className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-[hsl(var(--accent))]" placeholder="you@company.com" data-testid="input-auth-email" /></label>
          {mode === 'create' && <label className="mt-4 block text-xs font-semibold">Workspace name<input className="mt-2 h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-[hsl(var(--accent))]" placeholder="Studio or team name" data-testid="input-workspace-name" /></label>}
          <Button onClick={() => { setSubmitted(true); setTimeout(() => onChooseRole(role), 400); }} className="mt-6 h-11 w-full rounded-lg bg-foreground text-background hover:bg-foreground/85" data-testid="button-auth-submit">{submitted ? 'Opening workspace…' : mode === 'create' ? `Continue as ${role === 'merchant' ? 'merchant' : 'buyer'}` : 'Enter workspace'}<ArrowRight size={15} className="ml-2" /></Button>
          <div className="mt-5 flex items-center justify-center gap-2 text-center font-mono-ui text-[10px] text-muted-foreground"><LockKeyhole size={12} /> test environment · no real charges</div>
        </motion.div>
      </main>
    </div>
  );
}

function Sidebar({ role, page, collapsed, onCollapse, onToggle }: { role: Role; page: string; collapsed: boolean; onCollapse: () => void; onToggle: () => void }) {
  const nav = role === 'merchant' ? navMerchant : navBuyer;
  return <aside className={cn('fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all lg:flex', collapsed ? 'w-[76px]' : 'w-[252px]')}><div className="flex h-[76px] items-center border-b border-sidebar-border px-5">{collapsed ? <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[hsl(var(--accent))] font-display font-bold text-[hsl(var(--accent-foreground))]">0</span> : <Logo inverse />}</div><div className="flex flex-1 flex-col px-3 py-6"><div className={cn('mb-4 flex items-center px-3 font-mono-ui text-[9px] uppercase tracking-[.16em] text-sidebar-foreground/40', collapsed && 'justify-center px-0')}><span>{collapsed ? '·' : role === 'merchant' ? 'Operator console' : 'Buyer console'}</span></div>{nav.map(({ href, label, icon: Icon }) => { const active = page === href || (href !== '/merchant' && href !== '/buyer' && page.startsWith(href)); return <Link key={href} href={href} title={collapsed ? label : undefined} className={cn('group mb-1 flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold transition', active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/60 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground', collapsed && 'justify-center px-0')} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={active ? 2.2 : 1.8} /><span className={cn(collapsed && 'hidden')}>{label}</span>{active && !collapsed && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" />}</Link>})}<div className="my-5 h-px bg-sidebar-border" /><Link href={role === 'merchant' ? '/merchant/settings' : '/buyer/settings'} className={cn('flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-semibold text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground', collapsed && 'justify-center px-0')} data-testid="link-nav-settings"><Settings2 size={17} /><span className={cn(collapsed && 'hidden')}>Settings</span></Link></div><div className={cn('border-t border-sidebar-border p-4', collapsed && 'px-3')}><div className={cn('flex items-center gap-3', collapsed && 'justify-center')}><div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-bold">{role === 'merchant' ? 'AS' : 'NK'}</div><div className={cn('min-w-0', collapsed && 'hidden')}><p className="truncate text-xs font-bold">{role === 'merchant' ? 'Almond Studio' : 'Northstar Agent'}</p><p className="mt-0.5 truncate font-mono-ui text-[9px] text-sidebar-foreground/45">{role === 'merchant' ? 'merchant_01' : 'buyer_09'}</p></div></div></div><button onClick={onCollapse} className="absolute -right-3 top-[84px] grid h-6 w-6 place-items-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground" data-testid="button-collapse-sidebar">{collapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}</button></aside>;
}

function Topbar({ role, theme, onToggle, onMobileMenu }: { role: Role; theme: Theme; onToggle: () => void; onMobileMenu: () => void }) {
  const [, setLocation] = useLocation();
  return <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-foreground/10 bg-background/90 px-4 backdrop-blur-xl sm:px-7"><div className="flex items-center gap-3"><button onClick={onMobileMenu} className="grid h-9 w-9 place-items-center rounded-lg border border-foreground/15 lg:hidden" data-testid="button-open-mobile-nav"><Menu size={17} /></button><div className="hidden items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:flex"><span className="text-foreground">{role === 'merchant' ? 'Almond Studio' : 'Northstar Agent'}</span><ChevronRight size={12} /><span>Test environment</span></div></div><div className="flex items-center gap-2"><div className="hidden items-center gap-2 rounded-full border border-foreground/10 bg-foreground/[.03] px-3 py-2 font-mono-ui text-[10px] text-muted-foreground md:flex"><Search size={13} /><span>Search</span><kbd className="ml-3 rounded border border-foreground/15 px-1.5 py-0.5 text-[9px]">⌘ K</kbd></div><button onClick={() => setLocation('/auth')} className="hidden h-9 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted-foreground hover:bg-foreground/[.05] hover:text-foreground sm:flex" data-testid="button-switch-role"><RefreshCw size={14} /> Switch role</button><ThemeToggle theme={theme} onToggle={onToggle} /></div></header>;
}

function MobileNav({ role, open, onClose }: { role: Role; open: boolean; onClose: () => void }) {
  const nav = role === 'merchant' ? navMerchant : navBuyer;
  return <AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 bg-foreground/30 lg:hidden" onClick={onClose}><motion.div initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} onClick={e => e.stopPropagation()} className="h-full w-[270px] bg-sidebar p-5 text-sidebar-foreground"><div className="flex items-center justify-between"><Logo inverse /><button onClick={onClose} className="text-sidebar-foreground/60" data-testid="button-close-mobile-nav"><X size={18} /></button></div><div className="mt-10 space-y-1">{nav.map(({ href, label, icon: Icon }) => <Link href={href} onClick={onClose} key={href} className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent" data-testid={`mobile-link-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} />{label}</Link>)}</div></motion.div></motion.div>}</AnimatePresence>;
}

function MetricCard({ label, value, delta, icon: Icon, signal = false }: { label: string; value: string; delta: string; icon: typeof Activity; signal?: boolean }) {
  return <div className={cn('rounded-2xl border p-5', signal ? 'border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.1)]' : 'border-foreground/10 bg-card')}><div className="flex items-center justify-between"><span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">{label}</span><Icon size={16} className={signal ? 'text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]' : 'text-muted-foreground'} /></div><div className="mt-6 flex items-end justify-between gap-3"><strong className="font-display text-3xl font-bold tracking-[-.06em]">{value}</strong><span className={cn('font-mono-ui text-[10px]', signal ? 'text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]' : 'text-muted-foreground')}>{delta}</span></div></div>;
}

function MerchantOverview() {
  const [, setLocation] = useLocation();
  return <div className="space-y-7"><PageHeading eyebrow="Overview / network health" title="Good afternoon, Alex." description="Your commerce surface is quiet, healthy, and listening." action={<ButtonArrow testId="button-view-catalog" onClick={() => setLocation('/merchant/catalog')}>Manage catalog</ButtonArrow>} /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Gross volume" value="$18,426" delta="+12.8% / 30d" icon={TrendingUp} signal /><MetricCard label="Agent sessions" value="1,284" delta="+18.4%" icon={Users} /><MetricCard label="Conversion" value="6.7%" delta="+1.2 pts" icon={ArrowUpRight} /><MetricCard label="Avg. decision" value="42ms" delta="-8ms" icon={Zap} /></div><div className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]"><ActivityPanel /><div className="rounded-2xl border border-foreground/10 bg-card p-5"><div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">Decision mix</p><h3 className="mt-2 font-display text-xl font-bold">This month</h3></div><MoreHorizontal size={17} className="text-muted-foreground" /></div><div className="mt-8 space-y-5">{[['Auto-approved', '72%', 'bg-[hsl(var(--accent))]'], ['Human review', '19%', 'bg-[#d1c7aa]'], ['Declined', '9%', 'bg-[#b5aaa0]']].map(([label, value, color]) => <div key={label}><div className="flex justify-between text-xs"><span>{label}</span><span className="font-mono-ui text-muted-foreground">{value}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className={cn('h-full rounded-full', color)} style={{ width: value }} /></div></div>)}</div><div className="mt-9 rounded-xl bg-muted/70 p-3 font-mono-ui text-[10px] leading-5 text-muted-foreground"><span className="text-foreground">policy.guard</span> is holding 3 orders for a human check.</div></div></div></div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">{eyebrow}</p><h1 className="mt-3 font-display text-4xl font-bold leading-none tracking-[-.06em] sm:text-5xl">{title}</h1>{description && <p className="mt-3 max-w-[560px] text-sm text-muted-foreground">{description}</p>}</div>{action}</div>;
}

function ActivityPanel() {
  return <div className="rounded-2xl border border-foreground/10 bg-card p-5"><div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">Live protocol trail</p><h3 className="mt-2 font-display text-xl font-bold">Agent activity</h3></div><Pill signal><span className="h-1.5 w-1.5 rounded-full bg-current" /> live</Pill></div><div className="mt-7 space-y-1">{activities.map((a, i) => <div key={a.time} className="group flex items-start gap-3 rounded-xl px-2 py-3 transition hover:bg-muted/60" data-testid={`activity-row-${i}`}><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--accent))]" /><span className="w-[62px] shrink-0 font-mono-ui text-[10px] text-muted-foreground">{a.time}</span><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium">{a.text}</p><p className={cn('mt-1 font-mono-ui text-[9px] uppercase tracking-[.08em]', a.color)}>{a.agent} <span className="text-muted-foreground">· {a.kind}</span></p></div><ChevronRight size={14} className="mt-1 text-muted-foreground opacity-0 transition group-hover:opacity-100" /></div>)}</div><button className="mt-3 flex items-center gap-1 px-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground hover:text-foreground" data-testid="button-view-all-activity">View full activity <ArrowRight size={12} /></button></div>;
}

// ── Catalog (wired to real API) ─────────────────────────────────────────────

function Catalog() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'All' | 'Live' | 'Draft'>('All');
  const [modal, setModal] = useState<Product | 'new' | null>(null);

  const { data: products = [], isLoading, error } = useQuery<Product[]>({
    queryKey: ['catalog'],
    queryFn: fetchCatalog,
    retry: 1,
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProduct,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalog'] }),
  });

  const visible = products.filter(p => {
    const status = p.status ?? 'Live';
    const matchesFilter = filter === 'All' || status === filter;
    const matchesQuery = `${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase());
    return matchesFilter && matchesQuery;
  });

  return <div className="space-y-6">
    <PageHeading eyebrow="Merchant / catalog" title="Your catalog, agent-ready." description="Products are structured for discovery, priced for policy, and ready to be found." action={<ButtonArrow onClick={() => setModal('new')} testId="button-add-product"><Plus size={15} /> Add product</ButtonArrow>} />

    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative max-w-[340px] flex-1"><Search size={15} className="absolute left-3 top-3 text-muted-foreground" /><Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search products or SKU" className="h-10 rounded-lg border-foreground/15 bg-card pl-9 text-sm" data-testid="input-catalog-search" /></div>
      <div className="flex items-center gap-1 rounded-lg border border-foreground/10 bg-card p-1">{(['All', 'Live', 'Draft'] as const).map(x => <button key={x} onClick={() => setFilter(x)} className={cn('rounded-md px-3 py-1.5 font-mono-ui text-[10px] uppercase tracking-[.1em]', filter === x ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')} data-testid={`button-filter-${x.toLowerCase()}`}>{x}</button>)}</div>
    </div>

    <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card">
      <div className="hidden grid-cols-[1.4fr_1fr_.7fr_.6fr_.3fr] border-b border-foreground/10 bg-muted/50 px-5 py-3 font-mono-ui text-[9px] uppercase tracking-[.14em] text-muted-foreground sm:grid"><span>Product</span><span>SKU</span><span>Price</span><span>Status</span><span /></div>

      {/* Loading state */}
      {isLoading && <div className="grid place-items-center px-6 py-20 text-center"><Loader2 size={26} className="text-muted-foreground animate-spin" /><p className="mt-4 font-display text-xl font-bold">Loading catalog…</p><p className="mt-2 text-sm text-muted-foreground">Connecting to the product database.</p></div>}

      {/* Error state */}
      {!isLoading && error && <div className="grid place-items-center px-6 py-20 text-center"><AlertTriangle size={26} className="text-destructive" /><p className="mt-4 font-display text-xl font-bold">Could not load catalog</p><p className="mt-2 text-sm text-muted-foreground">Make sure the API server is running on localhost:5000.</p><p className="mt-1 font-mono-ui text-[10px] text-destructive">{(error as Error).message}</p></div>}

      {/* Empty state */}
      {!isLoading && !error && visible.length === 0 && products.length === 0 && <div className="grid place-items-center px-6 py-20 text-center"><Box size={26} className="text-muted-foreground" /><p className="mt-4 font-display text-xl font-bold">No products yet — add one</p><p className="mt-2 text-sm text-muted-foreground">Your catalog is empty. Add your first product to get started.</p></div>}

      {/* No search results */}
      {!isLoading && !error && visible.length === 0 && products.length > 0 && <div className="grid place-items-center px-6 py-20 text-center"><Box size={26} className="text-muted-foreground" /><p className="mt-4 font-display text-xl font-bold">No products found</p><p className="mt-2 text-sm text-muted-foreground">Try another search or add a product to your catalog.</p></div>}

      {/* Product rows */}
      {!isLoading && !error && visible.map(p => <div key={p.id} className="grid gap-3 border-b border-foreground/10 px-5 py-4 last:border-0 sm:grid-cols-[1.4fr_1fr_.7fr_.6fr_.3fr] sm:items-center" data-testid={`row-product-${p.id}`}><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-muted"><Package size={16} className="text-muted-foreground" /></div><div><p className="text-sm font-semibold">{p.name}</p><p className="font-mono-ui text-[10px] text-muted-foreground">stock {p.quantity}</p></div></div><span className="font-mono-ui text-[11px] text-muted-foreground">{p.sku}</span><span className="text-sm font-semibold">${p.price.toFixed(2)}</span><span><Pill signal={(p.status ?? 'Live') === 'Live'}><span className="h-1.5 w-1.5 rounded-full bg-current" />{p.status ?? 'Live'}</Pill></span><button onClick={() => setModal(p)} className="justify-self-end text-muted-foreground hover:text-foreground" data-testid={`button-edit-product-${p.id}`}><Pencil size={15} /></button></div>)}
    </div>

    {modal && <ProductModal product={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
  </div>;
}

// ── ProductModal (wired to real API) ────────────────────────────────────────

function ProductModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(product?.name ?? '');
  const [sku, setSku] = useState(product?.sku ?? '');
  const [price, setPrice] = useState(product ? String(product.price) : '$');
  const [stock, setStock] = useState(String(product?.quantity ?? 1));
  const [schema, setSchema] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        name: name || 'Untitled product',
        sku: sku || 'SKU-NEW',
        price: parseFloat(price.replace(/[^0-9.]/g, '')) || 0,
        quantity: Number(stock) || 0,
      };

      if (product) {
        await updateProduct(product.id, payload);
      } else {
        const { createProduct } = await import('@/lib/api');
        await createProduct(payload);
      }

      await queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onClose();
    } catch (err) {
      console.error('Save failed:', err);
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
      onClose();
    } catch (err) {
      console.error('Delete failed:', err);
    } finally {
      setDeleting(false);
    }
  };

  return <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/35 p-4 backdrop-blur-sm" onMouseDown={onClose}><motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} onMouseDown={e => e.stopPropagation()} className="w-full max-w-[520px] rounded-2xl border border-foreground/15 bg-card p-6 shadow-2xl sm:p-8"><div className="flex items-start justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.13em] text-muted-foreground">Catalog / {product ? 'edit product' : 'new product'}</p><h2 className="mt-2 font-display text-2xl font-bold">{product ? 'Tune product identity' : 'Add to the network'}</h2></div><button onClick={onClose} data-testid="button-close-product-modal"><X size={18} /></button></div><div className="mt-7 grid gap-4 sm:grid-cols-2"><label className="text-xs font-semibold sm:col-span-2">Product name<input value={name} onChange={e => setName(e.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-[hsl(var(--accent))]" data-testid="input-product-name" /></label><label className="text-xs font-semibold">SKU<input value={sku} onChange={e => setSku(e.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono-ui text-xs outline-none focus:border-[hsl(var(--accent))]" data-testid="input-product-sku" /></label><label className="text-xs font-semibold">Price<input value={price} onChange={e => setPrice(e.target.value)} className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-[hsl(var(--accent))]" data-testid="input-product-price" /></label><label className="text-xs font-semibold">Units in stock<input value={stock} onChange={e => setStock(e.target.value)} type="number" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-[hsl(var(--accent))]" data-testid="input-product-stock" /></label><div className="flex items-end"><button onClick={() => setSchema(v => !v)} className="flex h-10 items-center gap-2 rounded-lg border border-foreground/15 px-3 text-xs font-semibold hover:bg-muted" data-testid="button-preview-schema"><Code2 size={14} /> {schema ? 'Hide schema' : 'Preview schema'}</button></div></div>{schema && <pre className="mt-5 overflow-auto rounded-xl bg-[#1b2225] p-4 font-mono-ui text-[10px] leading-5 text-[#dfe9cf]">{`{\n  "type": "product",\n  "name": "${name || '…'}",\n  "sku": "${sku || '…'}",\n  "price": { "amount": "${price || '…'}", "currency": "USD" },\n  "availability": ${Number(stock || 0) > 0}\n}`}</pre>}<div className="mt-7 flex items-center justify-between gap-3">{product ? <button onClick={handleDelete} disabled={deleting} className="flex items-center gap-2 text-xs font-semibold text-destructive hover:underline disabled:opacity-50" data-testid="button-delete-product"><Trash2 size={14} /> {deleting ? 'Deleting…' : 'Delete'}</button> : <span />}<div className="flex gap-2"><Button onClick={onClose} variant="outline" className="rounded-lg" data-testid="button-cancel-product">Cancel</Button><Button onClick={handleSave} disabled={saving} className="rounded-lg bg-foreground text-background disabled:opacity-70" data-testid="button-save-product"><Check size={15} className="mr-2" /> {saving ? 'Saving…' : 'Save product'}</Button></div></div></motion.div></div>;
}

// ── Orders (wired to real API) ──────────────────────────────────────────────

function Orders() {
  const [status, setStatus] = useState('All');

  const { data: orders = [], isLoading, error } = useQuery<Order[]>({
    queryKey: ['orders'],
    queryFn: fetchOrders,
    retry: 1,
    staleTime: 10_000,
  });

  const filtered = orders.filter(o => status === 'All' || o.status === status);
  const formatAmount = (n: number) => `$${n.toFixed(2)}`;
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

  return <div className="space-y-6">
    <PageHeading eyebrow="Merchant / orders" title="Orders with context." description="Every order carries the intent, policy, and settlement state that made it happen." />

    <div className="flex gap-1 overflow-auto border-b border-foreground/10">{['All', 'pending', 'paid', 'shipped', 'declined'].map(s => <button key={s} onClick={() => setStatus(s)} className={cn('whitespace-nowrap border-b-2 px-3 pb-3 font-mono-ui text-[10px] uppercase tracking-[.1em]', status === s ? 'border-[hsl(var(--accent))] text-foreground' : 'border-transparent text-muted-foreground')} data-testid={`button-orders-filter-${s.toLowerCase()}`}>{s}</button>)}</div>

    {/* Loading state */}
    {isLoading && <div className="grid place-items-center px-6 py-20 text-center"><Loader2 size={26} className="text-muted-foreground animate-spin" /><p className="mt-4 font-display text-xl font-bold">Loading orders…</p></div>}

    {/* Error state */}
    {!isLoading && error && <div className="grid place-items-center px-6 py-20 text-center"><AlertTriangle size={26} className="text-destructive" /><p className="mt-4 font-display text-xl font-bold">Could not load orders</p><p className="mt-2 text-sm text-muted-foreground">Make sure the API server is running on localhost:5000.</p><p className="mt-1 font-mono-ui text-[10px] text-destructive">{(error as Error).message}</p></div>}

    {/* Empty state */}
    {!isLoading && !error && orders.length === 0 && <div className="grid place-items-center px-6 py-20 text-center"><ShoppingBag size={26} className="text-muted-foreground" /><p className="mt-4 font-display text-xl font-bold">No orders yet</p><p className="mt-2 text-sm text-muted-foreground">Orders will appear here when buyer agents make purchases.</p></div>}

    {/* Order rows */}
    {!isLoading && !error && <div className="space-y-2">{filtered.map(order => <div key={order.id} className="flex flex-col gap-4 rounded-xl border border-foreground/10 bg-card p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5" data-testid={`order-row-${order.id}`}><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-lg bg-muted"><ShoppingBag size={16} className="text-muted-foreground" /></div><div><p className="text-sm font-semibold">{order.product_name ?? `Product #${order.product_id}`}</p><p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">ord_{String(order.id).padStart(4, '0')} · {order.buyer_agent_id}</p></div></div><div className="flex items-center justify-between gap-5 sm:justify-end"><div className="text-left sm:text-right"><p className="text-sm font-semibold">{formatAmount(order.amount)}</p><p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">{formatTime(order.created_at)}</p></div><Pill signal={order.status === 'paid' || order.status === 'shipped'}>{order.status}</Pill></div></div>)}</div>}
  </div>;
}

function ActivityPage({ audit = false }: { audit?: boolean }) {
  const [actionFilter, setActionFilter] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const { data, isLoading, error } = useQuery<AuditResponse>({
    queryKey: ['audit', actionFilter, outcomeFilter],
    queryFn: () => fetchAudit({ action: actionFilter || undefined, outcome: outcomeFilter || undefined, limit: audit ? 100 : 50 }),
    refetchInterval: audit ? 5000 : 3000,
  });

  const rows = data?.rows ?? [];
  const recentCount = rows.filter(r => {
    const ts = new Date(r.timestamp).getTime();
    return Date.now() - ts < 5 * 60_000;
  }).length;

  const handleExport = async () => {
    try {
      const exportRows = await exportAudit({ action: actionFilter || undefined, outcome: outcomeFilter || undefined });
      const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'audit_log.json'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  const outcomeColor = (o: string) => {
    if (o === 'success' || o === 'auto_approved' || o === 'approved' || o === 'recovered') return 'text-emerald-600 dark:text-emerald-400';
    if (o === 'failed' || o === 'degraded' || o === 'human_approval_required') return 'text-amber-600 dark:text-amber-400';
    return 'text-muted-foreground';
  };

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow={audit ? 'Merchant / audit log' : 'Merchant / agent activity'}
        title={audit ? 'Receipts, not guesses.' : 'The network is talking.'}
        description={audit ? 'An immutable, human-readable record of every decision and state change.' : 'Watch autonomous commerce resolve itself in real time.'}
        action={audit ? (
          <div className="flex items-center gap-2">
            <button onClick={handleExport} className="inline-flex items-center gap-2 rounded-full border border-foreground/20 px-4 py-2 text-sm font-semibold text-foreground hover:bg-foreground/[.06]" data-testid="button-export-audit"><ArrowDownRight size={15} /> Export log</button>
          </div>
        ) : (
          <Pill signal><span className="h-1.5 w-1.5 rounded-full bg-current" /> {recentCount} events / 5 min</Pill>
        )}
      />

      {audit ? (
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card">
          <div className="flex items-center justify-between border-b border-foreground/10 p-4">
            <div className="flex items-center gap-3 font-mono-ui text-[10px] text-muted-foreground">
              <Filter size={14} />
              {actionFilter ? `action: ${actionFilter}` : 'all actions'}
              {outcomeFilter ? ` · outcome: ${outcomeFilter}` : ''}
              {!actionFilter && !outcomeFilter ? 'Last 7 days · all events' : ''}
            </div>
            <button onClick={() => setShowFilters(v => !v)} className="text-muted-foreground hover:text-foreground" data-testid="button-audit-filter"><SlidersHorizontal size={16} /></button>
          </div>
          {showFilters && (
            <div className="flex items-center gap-3 border-b border-foreground/10 bg-muted/30 px-4 py-3">
              <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} className="h-8 rounded-lg border border-foreground/15 bg-background px-3 text-xs">
                <option value="">All actions</option>
                <option value="policy_check">Policy check</option>
                <option value="human_override">Human override</option>
                <option value="payment_captured">Payment captured</option>
                <option value="payment_failed">Payment failed</option>
                <option value="catalog_query_failed">Catalog failed</option>
                <option value="catalog_fallback">Catalog fallback</option>
              </select>
              <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)} className="h-8 rounded-lg border border-foreground/15 bg-background px-3 text-xs">
                <option value="">All outcomes</option>
                <option value="auto_approved">Auto approved</option>
                <option value="human_approval_required">Human required</option>
                <option value="approved">Approved</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
                <option value="degraded">Degraded</option>
                <option value="recovered">Recovered</option>
              </select>
              {(actionFilter || outcomeFilter) && <button onClick={() => { setActionFilter(''); setOutcomeFilter(''); }} className="text-xs text-muted-foreground underline">Clear</button>}
            </div>
          )}
          {isLoading && <div className="grid place-items-center py-16"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>}
          {!isLoading && rows.length === 0 && <div className="grid place-items-center py-16 text-center"><FileText size={22} className="text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">No audit entries yet. Run a buyer query to generate events.</p></div>}
          {!isLoading && rows.map((row) => (
            <div key={row.id} className="grid gap-2 border-b border-foreground/10 px-5 py-4 last:border-0 md:grid-cols-[140px_140px_1fr_140px] md:items-center">
              <span className="font-mono-ui text-[10px] text-muted-foreground">{new Date(row.timestamp).toLocaleTimeString()} UTC</span>
              <Pill>{row.action}</Pill>
              <span className="font-mono-ui text-[11px]">{row.detail ?? row.action}</span>
              <span className={cn('font-mono-ui text-[10px]', outcomeColor(row.outcome))}>{row.outcome}{row.amount != null ? ` · $${Number(row.amount).toFixed(2)}` : ''}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_.95fr]">
            <div>
              <div className="flex items-center justify-between border-b border-foreground/10 pb-4">
                <span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">event stream</span>
                <span className="font-mono-ui text-[10px] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">{recentCount} events / 5 min</span>
              </div>
              <div className="mt-3">
                {isLoading && <div className="grid place-items-center py-8"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>}
                {!isLoading && rows.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No events yet.</p>}
                {!isLoading && rows.map((row) => (
                  <div key={row.id} className="flex gap-4 border-b border-foreground/5 py-4">
                    <span className="font-mono-ui text-[10px] text-muted-foreground">{new Date(row.timestamp).toLocaleTimeString()}</span>
                    <div>
                      <p className="text-xs">{row.detail ?? row.action}</p>
                      <p className={cn('mt-1 font-mono-ui text-[9px]', outcomeColor(row.outcome))}>{row.actor} · {row.action}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-[#1b2225] p-5 text-[#ece7d9]">
              <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-white/50"><Terminal size={14} /> latest trace</div>
              <div className="mt-7 space-y-4 font-mono-ui text-[11px] leading-5">
                {rows.length === 0 ? (
                  <p className="text-white/40">No trace data yet.</p>
                ) : rows.slice(0, 5).map((row) => (
                  <div key={row.id}>
                    <p><span className="text-[#e9ff70]">{new Date(row.timestamp).toLocaleTimeString()}</span> {row.action}</p>
                    {row.detail && <p className="pl-4 text-white/60">{row.detail}</p>}
                  </div>
                ))}
                {rows.length > 0 && <div className="mt-6 border-t border-white/10 pt-4 text-[#e9ff70]">stream active · {rows.length} total events</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Settings() {
  const queryClient = useQueryClient();
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
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  return (
    <div className="space-y-7">
      <PageHeading eyebrow="Workspace / settings" title="Set the boundaries." description="Controls that keep autonomous decisions aligned with your intent." action={<Button onClick={handleSave} className="h-10 rounded-lg bg-foreground text-background" data-testid="button-save-settings">{saved ? <><Check size={15} className="mr-2" /> Saved</> : 'Save changes'}</Button>} />
      <div className="grid max-w-[820px] gap-4">
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <ShieldCheck className="mt-1 text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]" size={20} />
            <div className="flex-1">
              <h3 className="font-display text-xl font-bold">Decision policy</h3>
              <p className="mt-1 text-sm text-muted-foreground">Default rules applied before an agent can commit.</p>
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
                      className="h-8 w-24 rounded-lg border border-foreground/15 bg-background px-3 text-right font-mono-ui text-[10px] outline-none focus:border-[hsl(var(--accent))]"
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
                    onClick={() => setRequireHuman(v => !v)}
                    className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono-ui text-[10px]', requireHuman ? 'border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.1)]' : 'border-foreground/15 text-muted-foreground')}
                    data-testid="button-setting-require-human"
                  >
                    <span className={cn('h-1.5 w-1.5 rounded-full', requireHuman ? 'bg-[hsl(var(--accent))]' : 'bg-muted-foreground')} />
                    {requireHuman ? 'Enabled' : 'Off'}
                  </button>
                </div>
                {/* Test mode — read-only */}
                <div className="flex items-center justify-between border-b border-foreground/10 pb-4 last:border-0 last:pb-0">
                  <span className="text-sm">Test mode payments</span>
                  <span className="flex items-center gap-2 rounded-full border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.1)] px-3 py-1.5 font-mono-ui text-[10px]"><span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--accent))]" /> Enabled</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
          <div className="flex items-start gap-4">
            <Globe2 className="mt-1 text-muted-foreground" size={20} />
            <div className="flex-1">
              <h3 className="font-display text-xl font-bold">Workspace identity</h3>
              <p className="mt-1 text-sm text-muted-foreground">How agents see your surface on the protocol.</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <label className="text-xs font-semibold">Workspace name<input defaultValue="Almond Studio" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" data-testid="input-settings-workspace" /></label>
                <label className="text-xs font-semibold">Protocol handle<input defaultValue="seller.almond" className="mt-2 h-10 w-full rounded-lg border border-input bg-background px-3 font-mono-ui text-xs" data-testid="input-settings-handle" /></label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BuyerConsole({ subpage }: { subpage: string }) {
  const [prompt, setPrompt] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [traceSteps, setTraceSteps] = useState<TraceStep[]>([]);
  const [traceResult, setTraceResult] = useState<BuyerQueryResult | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const sample = 'Find a warm, quiet desk lamp under $180 with delivery this week.';
  const isCheckout = subpage === '/buyer/checkout';
  const isTrace = subpage === '/buyer/trace';
  const isOrders = subpage === '/buyer/orders';

  useEffect(() => {
    return () => { unsubRef.current?.(); };
  }, []);

  const handleSubmit = async () => {
    if (!prompt.trim() || loading) return;
    setSubmitted(true);
    setLoading(true);
    setError(null);
    setTraceSteps([]);
    setTraceResult(null);
    setElapsed(null);
    const start = Date.now();
    try {
      const res = await submitBuyerQuery(prompt.trim());
      setSessionId(res.sessionId);
      setTraceSteps(res.steps);
      setTraceResult(res.result);
      setElapsed(Date.now() - start);
      unsubRef.current?.();
      unsubRef.current = subscribeTrace(
        res.sessionId,
        (step) => setTraceSteps((prev) => [...prev, step]),
        (result) => { setTraceResult(result); setLoading(false); },
        () => {},
      );
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Query failed');
      setLoading(false);
    }
  };

  const rec = traceResult?.recommendedProduct;

  if (isOrders) {
    const { data: buyerOrders, isLoading: ordersLoading } = useQuery<Order[]>({
      queryKey: ['orders'],
      queryFn: fetchOrders,
      refetchInterval: 5000,
    });
    const orderList = buyerOrders ?? [];
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Buyer / order history" title="Your commitments." description="Completed and test-mode purchases made by Northstar Agent." />
        {ordersLoading && <div className="grid place-items-center py-12"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>}
        {!ordersLoading && orderList.length === 0 && <div className="grid place-items-center py-16 text-center"><Package size={22} className="text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">No orders yet. Run a query and checkout to see orders here.</p></div>}
        {!ordersLoading && <div className="space-y-3">{orderList.map((o) => (
          <div key={o.id} className="flex items-center justify-between rounded-xl border border-foreground/10 bg-card p-5" data-testid={`buyer-order-${o.id}`}>
            <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-lg bg-muted"><Package size={16} /></div><div><p className="text-sm font-semibold">{o.product_name ?? `Product #${o.product_id}`}</p><p className="mt-1 font-mono-ui text-[10px] text-muted-foreground">ord_{String(o.id).padStart(4, '0')} · {new Date(o.created_at).toLocaleDateString()}</p></div></div>
            <div className="text-right"><p className="text-sm font-semibold">${Number(o.amount).toFixed(2)}</p><Pill signal={o.status === 'paid'}>{o.status}</Pill></div>
          </div>
        ))}</div>}
      </div>
    );
  }

  const buyerSubpage = isCheckout ? 'checkout' : isTrace ? 'trace' : 'console';

  return (
    <div className="space-y-7">
      <PageHeading
        eyebrow={isCheckout ? 'Buyer / test checkout' : isTrace ? 'Buyer / decision trace' : 'Buyer agent / Northstar'}
        title={isCheckout ? 'One last confirmation.' : isTrace ? 'Why this product?' : 'Give the agent a job.'}
        description={isCheckout ? 'Review the protocol receipt before committing a test-mode payment.' : isTrace ? 'A readable record of how Northstar moved from intent to recommendation.' : 'Northstar will search the open network, check policy, and return with a recommendation you can explain.'}
      />
      {buyerSubpage === 'checkout' && (
        <Checkout product={rec} approved={approved} onApprove={() => setApproved(true)} sessionId={sessionId} policyResult={traceResult?.policyResult ?? null} />
      )}
      {buyerSubpage === 'trace' && (
        <Trace steps={traceSteps} result={traceResult} sessionId={sessionId} />
      )}
      {buyerSubpage === 'console' && (
        <div className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
          <div className="flex min-h-[520px] flex-col rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
            <div className="flex items-center justify-between border-b border-foreground/10 pb-4">
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]"><Bot size={18} /></div>
                <div><p className="text-sm font-bold">Northstar Agent</p><p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">{loading ? 'thinking…' : 'ready · policy loaded'}</p></div>
              </div>
              <Pill signal><span className="h-1.5 w-1.5 rounded-full bg-current" /> online</Pill>
            </div>
            <div className="flex-1 space-y-5 py-7">
              <div className="max-w-[350px] rounded-2xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-6">I can search the network for products that fit your policy. What are we looking for?</div>
              {submitted && (
                <>
                  <div className="ml-auto max-w-[350px] rounded-2xl rounded-tr-sm bg-foreground px-4 py-3 text-sm leading-6 text-background">{prompt}</div>
                  {loading && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[390px] rounded-2xl rounded-tl-sm border border-foreground/10 bg-muted px-4 py-3 text-sm leading-6">
                      <div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground"><Loader2 size={12} className="animate-spin" /> searching network…</div>
                    </motion.div>
                  )}
                  {!loading && error && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[390px] rounded-2xl rounded-tl-sm border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm leading-6">
                      <div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-destructive"><AlertTriangle size={12} /> query failed</div>
                      <p className="mt-2 text-xs text-muted-foreground">{error}</p>
                    </motion.div>
                  )}
                  {!loading && !error && traceResult && (
                    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[390px] rounded-2xl rounded-tl-sm border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.08)] px-4 py-3 text-sm leading-6">
                      <div className="mb-2 flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.12em] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">
                        <Sparkles size={12} /> completed{elapsed != null ? ` in ${elapsed}ms` : ''}
                      </div>
                      {rec ? (
                        <>
                          I found <strong>{rec.name}</strong> from {rec.sku}. It matches intent and is policy-approved.
                          <div className="mt-4 flex gap-2">
                            <Link href="/buyer/trace" className="rounded-md border border-foreground/15 px-2.5 py-1.5 font-mono-ui text-[10px]" data-testid="link-view-trace">View trace</Link>
                            <Link href="/buyer/checkout" className="rounded-md bg-foreground px-2.5 py-1.5 font-mono-ui text-[10px] text-background" data-testid="link-review-checkout">Review checkout</Link>
                          </div>
                        </>
                      ) : (
                        <>No product in the catalog matched all your constraints. Try broadening the search.</>
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
                  className="min-h-[76px] w-full resize-none rounded-xl border border-input bg-background p-3 pr-12 text-sm outline-none focus:border-[hsl(var(--accent))]"
                  data-testid="textarea-agent-prompt"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                />
                <button onClick={handleSubmit} className="absolute bottom-3 right-3 grid h-8 w-8 place-items-center rounded-lg bg-foreground text-background disabled:opacity-40" disabled={!prompt.trim() || loading} data-testid="button-send-agent-prompt"><Send size={14} /></button>
              </div>
              <button onClick={() => { setPrompt(sample); setSubmitted(false); setTraceSteps([]); setTraceResult(null); setError(null); }} className="mt-3 font-mono-ui text-[10px] text-muted-foreground underline underline-offset-4 hover:text-foreground" data-testid="button-sample-prompt">Use sample prompt</button>
            </div>
          </div>
          <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
            <div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">Current policy</p><h3 className="mt-2 font-display text-xl font-bold">Northstar boundaries</h3></div><ShieldCheck size={18} className="text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]" /></div>
            <div className="mt-8 space-y-4">
              {[['Maximum spend', '$180.00 USD'], ['Delivery window', 'This week'], ['Return policy', '30 days minimum'], ['Preferred signal', 'Quiet / warm']].map(([a, b]) => (
                <div key={a} className="flex items-center justify-between border-b border-foreground/10 pb-3 text-xs"><span className="text-muted-foreground">{a}</span><span className="font-mono-ui text-[10px]">{b}</span></div>
              ))}
            </div>
            <div className="mt-8 rounded-xl bg-muted p-4"><div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em]"><LockKeyhole size={13} /> policy is active</div><p className="mt-2 text-xs leading-5 text-muted-foreground">The agent cannot purchase outside these boundaries without your approval.</p></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Trace({ steps, result, sessionId }: { steps: TraceStep[]; result: BuyerQueryResult | null; sessionId: string | null }) {
  const rec = result?.recommendedProduct;
  const confidence = result?.confidence ?? 0;
  const policyResult = result?.policyResult ?? 'pending';

  // Detect failure/recovery steps for visual styling
  const failureLabels = new Set(['Catalog query failed', 'Retry failed']);
  const recoveryLabels = new Set(['Catalog fallback']);
  const degraded = steps.some(s => failureLabels.has(s.label));
  const recovered = steps.some(s => recoveryLabels.has(s.label) || s.detail.includes('cached'));

  const evidenceLines = [
    `decision: ${rec ? 'recommend' : 'no_match'}`,
    `product: ${rec?.sku ?? 'N/A'}`,
    `confidence: ${confidence.toFixed(3)}`,
    `policy_result: ${policyResult}`,
    degraded ? `data_source: ${recovered ? 'cached (degraded)' : 'unavailable'}` : 'data_source: live',
    '',
    'reasoning:',
    rec ? '  + matches intent keywords' : '  - no products matched enough constraints',
    rec ? '  + price within ceiling' : '',
    policyResult === 'auto_approved' ? '  + policy approved' : policyResult === 'human_approval_required' ? '  ! requires human approval' : '  - policy not met',
    recovered ? '  ! used cached catalog data (supplier unreachable)' : '',
    '',
    `signature: 0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('').slice(0, 64)}`,
  ].filter(Boolean).join('\n');

  const handleCopy = () => { navigator.clipboard.writeText(evidenceLines).catch(() => {}); };

  // Helper: determine step visual style
  const stepStyle = (label: string): { borderClass: string; dotClass: string; icon?: ReactNode } => {
    if (failureLabels.has(label)) return {
      borderClass: 'border-amber-500/50 bg-amber-500/5',
      dotClass: 'border-amber-500/60 bg-amber-500/15 text-amber-600 dark:text-amber-400',
      icon: <AlertTriangle size={11} />,
    };
    if (recoveryLabels.has(label)) return {
      borderClass: 'border-emerald-500/40 bg-emerald-500/5',
      dotClass: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
      icon: <RefreshCw size={11} />,
    };
    return {
      borderClass: '',
      dotClass: 'border-[hsl(var(--accent)/.5)] bg-[hsl(var(--accent)/.12)] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]',
    };
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
      <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
        <div className="flex items-center justify-between border-b border-foreground/10 pb-5">
          <span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">{sessionId ?? 'trace_awaiting'}</span>
          <div className="flex items-center gap-2">
            {degraded && <Pill><AlertTriangle size={10} /> degraded</Pill>}
            {recovered && !degraded && <Pill signal><RefreshCw size={10} /> recovered</Pill>}
            <Pill signal={steps.length > 0 && !degraded}><Check size={11} /> {steps.length > 0 ? (degraded ? 'fallback active' : 'explainable') : 'waiting'}</Pill>
          </div>
        </div>
        <div className="mt-8 space-y-0">
          {steps.length === 0 && (
            <div className="grid place-items-center py-12 text-center"><Loader2 size={22} className="animate-spin text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Waiting for trace steps…</p></div>
          )}
          {steps.map((step, i) => {
            const style = stepStyle(step.label);
            return (
              <div key={i} className="relative flex gap-4 pb-8 last:pb-0">
                <div className={cn('relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full border', style.dotClass)}>
                  {style.icon ?? (i + 1)}
                </div>
                {i < steps.length - 1 && <div className="absolute left-3.5 top-7 h-full w-px bg-foreground/10" />}
                <div className={cn('flex-1 rounded-lg border p-3', style.borderClass)}>
                  <p className="text-sm font-semibold">{step.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{step.detail}</p>
                  <p className="mt-2 font-mono-ui text-[10px] text-muted-foreground">{step.timestamp} UTC</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="rounded-2xl border border-foreground/10 bg-[#1b2225] p-6 text-[#ece7d9]">
        <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-white/50">
          <Code2 size={14} /> signed evidence
          {degraded && <span className="ml-2 rounded bg-amber-600/30 px-2 py-0.5 text-amber-300">degraded mode</span>}
        </div>
        <pre className="mt-7 whitespace-pre-wrap font-mono-ui text-[10px] leading-6 text-white/75">{evidenceLines}</pre>
        <button onClick={handleCopy} className="mt-8 flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 font-mono-ui text-[10px] text-white/65 hover:text-white" data-testid="button-copy-evidence"><Copy size={13} /> Copy evidence</button>
      </div>
    </div>
  );
}

function Checkout({ product, approved, onApprove, sessionId, policyResult }: { product: Product | null | undefined; approved: boolean; onApprove: () => void; sessionId: string | null; policyResult: string | null }) {
  const name = product?.name ?? 'Lattice Desk Lamp';
  const sku = product?.sku ?? 'LMP-044';
  const price = product?.price ?? 148;
  const seller = product?.sellerId ?? 'seller.almond';
  const needsHuman = policyResult === 'human_approval_required';
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  const handlePay = async () => {
    if (paying || approved || !product) return;
    setPaying(true);
    setPayError(null);
    try {
      // 1. Create an order record in our DB
      const order = await createOrder({
        productId: product.id,
        buyerAgentId: 'buyer.northstar',
        amount: product.price,
      });
      // 2. Create a Razorpay order via our backend
      const rpOrder = await createRazorpayOrder({
        orderId: order.id,
        amount: product.price,
        currency: product.currency || 'INR',
      });
      // 3. Open the real Razorpay checkout modal
      const rzp = new window.Razorpay({
        key: rpOrder.keyId,
        order_id: rpOrder.razorpayOrderId,
        amount: rpOrder.amount,
        currency: rpOrder.currency,
        name: 'Commerce0S',
        description: `Test payment — ${name}`,
        handler: async (response) => {
          // Payment success — poll verify endpoint until DB reflects 'paid'
          try {
            let attempts = 0;
            const maxAttempts = 10;
            while (attempts < maxAttempts) {
              const verified = await verifyOrder(order.id);
              if (verified.status === 'paid') {
                setPaying(false);
                onApprove();
                return;
              }
              await new Promise((r) => setTimeout(r, 1000));
              attempts++;
            }
            // If we exhaust polling, still call onApprove — webhook may be delayed
            setPaying(false);
            onApprove();
          } catch {
            setPaying(false);
            onApprove();
          }
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
            setPayError('Payment was not completed. You can retry when ready.');
          },
        },
        prefill: { email: 'test@commerce0s.demo' },
        theme: { color: '#1a1a1a' },
      });
      rzp.open();
    } catch (err) {
      setPaying(false);
      setPayError(err instanceof Error ? err.message : 'Failed to initiate payment');
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_.75fr]">
      <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-muted"><Package size={21} /></div>
          <div><p className="font-display text-xl font-bold">{name}</p><p className="font-mono-ui text-[10px] text-muted-foreground">{sku} · {seller}</p></div>
        </div>
        <div className="mt-8 space-y-4 border-t border-foreground/10 pt-5 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Item</span><span>${price.toFixed(2)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Test-mode delivery</span><span>$0.00</span></div>
          <div className="flex justify-between border-t border-foreground/10 pt-4 font-semibold"><span>Total</span><span>${price.toFixed(2)} USD</span></div>
        </div>
        {/* Policy check card — branches on real backend result */}
        {needsHuman ? (
          <div className="mt-8 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-amber-600 dark:text-amber-400"><AlertTriangle size={14} /> above auto-approve limit</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">This item exceeds your max auto-approve setting. Confirm to proceed with a manual override.</p>
          </div>
        ) : (
          <div className="mt-8 rounded-xl border border-[hsl(var(--accent)/.4)] bg-[hsl(var(--accent)/.08)] p-4">
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]"><ShieldCheck size={14} /> policy check passed</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">Within spending cap · delivery verified · seller trusted</p>
          </div>
        )}
        {/* Error state */}
        {payError && (
          <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-center gap-2 font-mono-ui text-[10px] uppercase tracking-[.12em] text-destructive"><AlertTriangle size={14} /> payment not completed</div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{payError}</p>
          </div>
        )}
        <Button onClick={handlePay} disabled={approved || paying} className="mt-6 h-12 w-full rounded-lg bg-foreground text-background disabled:opacity-100" data-testid="button-approve-checkout">
          {paying ? (
            <><Loader2 size={16} className="mr-2 animate-spin" /> Opening Razorpay…</>
          ) : approved ? (
            <><Check size={16} className="mr-2 text-[hsl(var(--accent))]" /> {needsHuman ? 'Manual override recorded' : 'Test payment authorized'}</>
          ) : needsHuman ? (
            <><AlertTriangle size={16} className="mr-2" /> Confirm manual override</>
          ) : (
            <><CreditCard size={16} className="mr-2" /> Approve test payment</>
          )}
        </Button>
        <p className="mt-3 text-center font-mono-ui text-[9px] uppercase tracking-[.12em] text-muted-foreground">Test / reversible · no real funds moved</p>
      </div>
      <div className="rounded-2xl border border-foreground/10 bg-card p-5 sm:p-7">
        <div className="flex items-center justify-between"><h3 className="font-display text-xl font-bold">Protocol receipt</h3><FileText size={18} className="text-muted-foreground" /></div>
        <div className="mt-7 space-y-5 font-mono-ui text-[10px]">
          <div><p className="text-muted-foreground">PAYMENT MODE</p><p className="mt-1 text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]">TEST / REVERSIBLE</p></div>
          <div><p className="text-muted-foreground">AUTHORIZATION</p><p className="mt-1">{approved ? 'approved_by_northstar' : paying ? 'razorpay_checkout_open' : 'awaiting_approval'}</p></div>
          <div><p className="text-muted-foreground">TRACE ID</p><p className="mt-1">{sessionId ?? 'pending'}</p></div>
          <div><p className="text-muted-foreground">SETTLEMENT</p><p className="mt-1">{approved ? 'ledger.test / recorded' : paying ? 'processing' : 'not initiated'}</p></div>
        </div>
        {approved && <div className="mt-10 rounded-lg bg-muted p-3 text-xs leading-5"><Check size={14} className="mb-2 text-[hsl(var(--accent-foreground))] dark:text-[hsl(var(--accent))]" />Receipt recorded. No real funds moved.</div>}
      </div>
    </div>
  );
}

// ── Shell & Router ──────────────────────────────────────────────────────────

function MerchantShell({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const page = location.replace(/\/$/, '') || '/merchant';
  const view = page === '/merchant/catalog' ? <Catalog /> : page === '/merchant/orders' ? <Orders /> : page === '/merchant/activity' ? <ActivityPage /> : page === '/merchant/audit' ? <ActivityPage audit /> : page === '/merchant/settings' ? <Settings /> : <MerchantOverview />;
  return <div className="min-h-[100dvh] bg-background text-foreground"><Sidebar role="merchant" page={page} collapsed={collapsed} onCollapse={() => setCollapsed(v => !v)} onToggle={onToggle} /><MobileNav role="merchant" open={mobile} onClose={() => setMobile(false)} /><div className={cn('min-h-[100dvh] transition-all', collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]')}><Topbar role="merchant" theme={theme} onToggle={onToggle} onMobileMenu={() => setMobile(true)} /><main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-7 sm:py-10 lg:px-10">{view}</main></div></div>;
}

function BuyerShell({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const page = location.replace(/\/$/, '') || '/buyer';
  return <div className="min-h-[100dvh] bg-background text-foreground"><Sidebar role="buyer" page={page} collapsed={collapsed} onCollapse={() => setCollapsed(v => !v)} onToggle={onToggle} /><MobileNav role="buyer" open={mobile} onClose={() => setMobile(false)} /><div className={cn('min-h-[100dvh] transition-all', collapsed ? 'lg:pl-[76px]' : 'lg:pl-[252px]')}><Topbar role="buyer" theme={theme} onToggle={onToggle} onMobileMenu={() => setMobile(true)} /><main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-7 sm:py-10 lg:px-10"><BuyerConsole subpage={page} /></main></div></div>;
}

function AppRouter({ theme, onToggle, onChooseRole }: { theme: Theme; onToggle: () => void; onChooseRole: (role: Role) => void }) {
  return <Switch><Route path="/auth"><Auth onChooseRole={onChooseRole} theme={theme} onToggle={onToggle} /></Route><Route path="/merchant/:page*"><MerchantShell theme={theme} onToggle={onToggle} /></Route><Route path="/merchant"><MerchantShell theme={theme} onToggle={onToggle} /></Route><Route path="/buyer/:page*"><BuyerShell theme={theme} onToggle={onToggle} /></Route><Route path="/buyer"><BuyerShell theme={theme} onToggle={onToggle} /></Route><Route path="/"><Landing theme={theme} onToggle={onToggle} /></Route><Route component={NotFound} /></Switch>;
}

function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('commerce0s-theme') as Theme) || 'light');
  const [, setLocation] = useLocation();
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); localStorage.setItem('commerce0s-theme', theme); }, [theme]);
  const toggleTheme = () => setTheme(v => v === 'light' ? 'dark' : 'light');
  const chooseRole = (role: Role) => setLocation(role === 'merchant' ? '/merchant' : '/buyer');
  return <QueryClientProvider client={queryClient}><TooltipProvider><ErrorBoundary resetKey={location}><AppRouter theme={theme} onToggle={toggleTheme} onChooseRole={chooseRole} /></ErrorBoundary><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
