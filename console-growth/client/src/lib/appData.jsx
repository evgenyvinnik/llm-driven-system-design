// Account data more than one page needs: who is signed in, and the org's billing state.
// Pages that change billing (Workbench runs, purchases, auto-reload) call refreshBilling().
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const AppDataContext = createContext(null);

export function AppDataProvider({ children }) {
  const [me, setMe] = useState(null);
  const [billing, setBilling] = useState(null);

  const refreshBilling = useCallback(() => api.billing().then(setBilling).catch(() => {}), []);

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    refreshBilling();
  }, [refreshBilling]);

  const value = useMemo(() => ({ me, billing, setBilling, refreshBilling }), [me, billing, refreshBilling]);
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData() {
  return useContext(AppDataContext);
}
