import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import CreditRunwayBanner from '../experiments/CreditRunwayBanner.jsx';
import { useAppData } from '../lib/appData.jsx';
import { track } from '../lib/instrumentation.js';
import DevToolbar from './DevToolbar.jsx';
import Toaster from './Toaster.jsx';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/workbench', label: 'Workbench' },
  { to: '/keys', label: 'API keys' },
  { to: '/usage', label: 'Usage' },
  { to: '/limits', label: 'Limits' },
];

const SETTINGS_NAV = [
  { to: '/settings/organization', label: 'Organization' },
  { to: '/settings/members', label: 'Members' },
  { to: '/settings/billing', label: 'Billing' },
  { to: '/settings/plans', label: 'Plans' },
];

function NavItem({ to, label, end }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const location = useLocation();
  const { me, billing, setBilling } = useAppData();

  useEffect(() => {
    track('page_viewed', { path: location.pathname });
  }, [location.pathname]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Console
        </div>
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
        <div className="nav-section">Settings</div>
        {SETTINGS_NAV.map((item) => (
          <NavItem key={item.to} {...item} />
        ))}
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="topbar-org">{me?.org.name ?? '…'}</span>
          <span className="topbar-user">{me ? `${me.user.name} · ${me.user.email}` : ''}</span>
        </header>
        <main className="content">
          <CreditRunwayBanner billing={billing} onBillingChange={setBilling} />
          <Outlet />
        </main>
      </div>
      <Toaster />
      <DevToolbar />
    </div>
  );
}
