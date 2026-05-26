import { useContext } from 'react';
import { BillingApiContext } from '../components/BillingApiProvider';
import { BillingApiOptionsProxy } from '../generated/billing-api/options-proxy.gen';

export const useBillingApi = (): BillingApiOptionsProxy => {
  const optionsProxy = useContext(BillingApiContext);

  if (!optionsProxy) {
    throw new Error('useBillingApi must be used within a BillingApiProvider');
  }

  return optionsProxy;
};
