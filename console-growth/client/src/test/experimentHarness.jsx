// Renders a component inside the real ExperimentsProvider and a router, with the API mocked by
// the calling test file (vi.mock('../api.js')). `variants` sets what GET /api/experiments returns;
// `loadError` makes it fail instead.
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { ExperimentsProvider, resetExposureCache } from '../lib/experiments.jsx';

export function mockAssignments(variants, { enabled = true } = {}) {
  api.experiments.mockResolvedValue({
    experiments: Object.entries(variants).map(([key, variant]) => ({
      key,
      variant,
      assigned: variant,
      variants: ['control', 'treatment'],
      weights: [50, 50],
      unit: 'org',
      unitId: 'org_northwind',
      overridden: false,
      enabled,
    })),
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

export function renderWithExperiments(ui, { variants = {}, enabled = true, loadError = null, path = '/' } = {}) {
  resetExposureCache();
  if (loadError) api.experiments.mockRejectedValue(loadError);
  else mockAssignments(variants, { enabled });
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ExperimentsProvider>
        <Routes>
          <Route path="*" element={ui} />
        </Routes>
        <LocationProbe />
      </ExperimentsProvider>
    </MemoryRouter>,
  );
}
