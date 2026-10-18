import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import { AppDataProvider } from './lib/appData.jsx';
import { ExperimentsProvider } from './lib/experiments.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Workbench from './pages/Workbench.jsx';
import ApiKeys from './pages/ApiKeys.jsx';
import Usage from './pages/Usage.jsx';
import Limits from './pages/Limits.jsx';
import Organization from './pages/settings/Organization.jsx';
import Members from './pages/settings/Members.jsx';
import Billing from './pages/settings/Billing.jsx';
import Plans from './pages/settings/Plans.jsx';

export default function App() {
  return (
    <ExperimentsProvider>
      <AppDataProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="workbench" element={<Workbench />} />
            <Route path="keys" element={<ApiKeys />} />
            <Route path="usage" element={<Usage />} />
            <Route path="limits" element={<Limits />} />
            <Route path="settings/organization" element={<Organization />} />
            <Route path="settings/members" element={<Members />} />
            <Route path="settings/billing" element={<Billing />} />
            <Route path="settings/plans" element={<Plans />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AppDataProvider>
    </ExperimentsProvider>
  );
}
