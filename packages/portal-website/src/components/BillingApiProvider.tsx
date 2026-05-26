import { createContext, FC, PropsWithChildren, useMemo } from 'react';
import { BillingApi } from '../generated/billing-api/client.gen';
import { BillingApiOptionsProxy } from '../generated/billing-api/options-proxy.gen';
import { useRuntimeConfig } from '../hooks/useRuntimeConfig';
import { useAuth } from 'react-oidc-context';

export const BillingApiContext = createContext<
  BillingApiOptionsProxy | undefined
>(undefined);

export const BillingApiClientContext = createContext<BillingApi | undefined>(
  undefined,
);

const useCreateBillingApiClient = (): BillingApi => {
  const runtimeConfig = useRuntimeConfig();
  const apiUrl = runtimeConfig.apis.BillingApi;
  const auth = useAuth();
  const user = auth?.user;
  const cognitoClient: typeof fetch = (url, init) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${user?.id_token}`,
    };
    const accountId = localStorage.getItem('billing-portal-selected-account');
    if (accountId) {
      headers['X-Account-Id'] = accountId;
    }
    const existingHeaders = init?.headers;

    return fetch(url, {
      ...init,
      headers: !existingHeaders
        ? headers
        : existingHeaders instanceof Headers
          ? (() => {
              const h = new Headers(existingHeaders);
              Object.entries(headers).forEach(([k, v]) => h.append(k, v));
              return h;
            })()
          : Array.isArray(existingHeaders)
            ? [...existingHeaders, ...Object.entries(headers)]
            : { ...existingHeaders, ...headers },
    });
  };
  return useMemo(
    () =>
      new BillingApi({
        url: apiUrl,
        fetch: cognitoClient,
      }),
    [apiUrl, cognitoClient],
  );
};

export const BillingApiProvider: FC<PropsWithChildren> = ({ children }) => {
  const client = useCreateBillingApiClient();
  const optionsProxy = useMemo(
    () => new BillingApiOptionsProxy({ client }),
    [client],
  );

  return (
    <BillingApiClientContext.Provider value={client}>
      <BillingApiContext.Provider value={optionsProxy}>
        {children}
      </BillingApiContext.Provider>
    </BillingApiClientContext.Provider>
  );
};

export default BillingApiProvider;
