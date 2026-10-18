import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.js';
import { renderWithExperiments } from '../test/experimentHarness.jsx';
import { useExperiment } from './experiments.jsx';

vi.mock('../api.js', () => ({
  api: { experiments: vi.fn(), logExposure: vi.fn(() => Promise.resolve()) },
}));

function Probe({ id = 'probe', options }) {
  const { variant, ready, isTreatment, logExposure } = useExperiment('credit_runway_autoreload', options);
  return (
    <button type="button" data-testid={id} onClick={() => logExposure({ surface: 'manual' })}>
      {ready ? `${variant}:${isTreatment}` : 'loading'}
    </button>
  );
}

describe('useExperiment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the server’s variant and logs one exposure', async () => {
    renderWithExperiments(<Probe options={{ exposureProps: { surface: 'app_banner' } }} />, { variants: { credit_runway_autoreload: 'treatment' } });
    expect(await screen.findByText('treatment:true')).toBeInTheDocument();
    expect(api.logExposure).toHaveBeenCalledTimes(1);
    expect(api.logExposure).toHaveBeenCalledWith('credit_runway_autoreload', { surface: 'app_banner' });
  });

  it('logs once per session even when several components read the same experiment', async () => {
    renderWithExperiments(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
      { variants: { credit_runway_autoreload: 'control' } },
    );
    await waitFor(() => expect(screen.getByTestId('a')).toHaveTextContent('control:false'));
    expect(api.logExposure).toHaveBeenCalledTimes(1);
  });

  it('waits for logExposure() when automatic exposure is off', async () => {
    renderWithExperiments(<Probe options={{ autoExposure: false }} />, { variants: { credit_runway_autoreload: 'treatment' } });
    const probe = await screen.findByText('treatment:true');
    expect(api.logExposure).not.toHaveBeenCalled();
    probe.click();
    expect(api.logExposure).toHaveBeenCalledWith('credit_runway_autoreload', { surface: 'manual' });
  });

  it('falls back to the control, without logging, when assignments fail to load', async () => {
    renderWithExperiments(<Probe />, { loadError: new Error('offline') });
    expect(await screen.findByText('control:false')).toBeInTheDocument();
    expect(api.logExposure).not.toHaveBeenCalled();
  });

  it('logs nothing for a switched-off experiment', async () => {
    renderWithExperiments(<Probe />, { variants: { credit_runway_autoreload: 'control' }, enabled: false });
    expect(await screen.findByText('control:false')).toBeInTheDocument();
    expect(api.logExposure).not.toHaveBeenCalled();
  });
});
