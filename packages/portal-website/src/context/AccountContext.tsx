import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { useApiFetch } from '../hooks/useApiFetch';

export interface Account {
  account_id: string;
  account_name: string;
  role_arn: string;
  external_id: string;
  region: string;
  status: string;
}

interface AccountContextType {
  accounts: Account[];
  selectedAccount: Account | null;
  setSelectedAccount: (account: Account | null) => void;
  refreshAccounts: () => Promise<void>;
  loading: boolean;
}

const AccountContext = createContext<AccountContextType>({
  accounts: [],
  selectedAccount: null,
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setSelectedAccount: () => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  refreshAccounts: async () => {},
  loading: false,
});

export const useAccountContext = () => useContext(AccountContext);

const STORAGE_KEY = 'billing-portal-selected-account';

export const AccountProvider = ({ children }: { children: ReactNode }) => {
  const { apiFetch } = useApiFetch();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccountState] = useState<Account | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const refreshAccounts = useCallback(async () => {
    try {
      const resp = await apiFetch('/accounts');
      const data = await resp.json();
      setAccounts(data.accounts || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setSelectedAccount = useCallback((account: Account | null) => {
    setSelectedAccountState(account);
    if (account) {
      localStorage.setItem(STORAGE_KEY, account.account_id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Load accounts on mount
  useEffect(() => {
    refreshAccounts();
  }, [refreshAccounts]);

  // Restore selection from localStorage
  useEffect(() => {
    if (accounts.length > 0) {
      const savedId = localStorage.getItem(STORAGE_KEY);
      const saved = accounts.find((a) => a.account_id === savedId);
      if (saved) {
        setSelectedAccountState(saved);
      } else {
        // Auto-select first account
        setSelectedAccountState(accounts[0]);
        localStorage.setItem(STORAGE_KEY, accounts[0].account_id);
      }
    }
  }, [accounts]);

  return (
    <AccountContext.Provider
      value={{
        accounts,
        selectedAccount,
        setSelectedAccount,
        refreshAccounts,
        loading,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
};
