import { BillingApi } from '../generated/billing-api/client.gen';
import { BillingApiClientContext } from '../components/BillingApiProvider';
import { useContext } from 'react';

export const useBillingApiClient = (): BillingApi => {
  const client = useContext(BillingApiClientContext);

  if (!client) {
    throw new Error(
      'useBillingApiClient must be used within a BillingApiProvider',
    );
  }

  return client;
};
