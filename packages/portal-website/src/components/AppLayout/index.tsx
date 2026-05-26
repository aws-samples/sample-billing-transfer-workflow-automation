import { useAuth } from 'react-oidc-context';
import * as React from 'react';
import { createContext, useCallback, useState } from 'react';
import Config from '../../config';
import ChatWidget from '../ChatWidget';
import { useAccountContext } from '../../context/AccountContext';

import { SideNavigation, TopNavigation } from '@cloudscape-design/components';
import CloudscapeAppLayout, {
  AppLayoutProps,
} from '@cloudscape-design/components/app-layout';
import { useLocation, useNavigate } from '@tanstack/react-router';

export interface AppLayoutContext {
  appLayoutProps: AppLayoutProps;
  setAppLayoutProps: (props: AppLayoutProps) => void;
  displayHelpPanel: (helpContent: React.ReactNode) => void;
}

/**
 * Context for updating/retrieving the AppLayout.
 */
export const AppLayoutContext = createContext({
  appLayoutProps: {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  setAppLayoutProps: (_: AppLayoutProps) => {},
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  displayHelpPanel: (_: React.ReactNode) => {},
});

/**
 * Defines the App layout and contains logic for routing.
 */
const AppLayout: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { user, removeUser, signoutRedirect, clearStaleState } = useAuth();
  const { accounts, selectedAccount, setSelectedAccount } = useAccountContext();
  const appLayout = React.useRef<AppLayoutProps.Ref>(null);
  const [appLayoutProps, setAppLayoutProps] = useState<AppLayoutProps>({});
  const setAppLayoutPropsSafe = useCallback(
    (props: AppLayoutProps) => {
      JSON.stringify(appLayoutProps) !== JSON.stringify(props) &&
        setAppLayoutProps(props);
    },
    [appLayoutProps],
  );
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const onNavigate = useCallback(
    (
      e: CustomEvent<{
        href: string;
        external?: boolean;
      }>,
    ) => {
      if (!e.detail.external) {
        e.preventDefault();
        setAppLayoutPropsSafe({
          contentType: undefined,
        });
        navigate({ to: e.detail.href });
      }
    },
    [navigate, setAppLayoutPropsSafe],
  );
  return (
    <AppLayoutContext.Provider
      value={{
        appLayoutProps,
        setAppLayoutProps: setAppLayoutPropsSafe,
        displayHelpPanel: (helpContent: React.ReactNode) => {
          setAppLayoutPropsSafe({ tools: helpContent, toolsHide: false });
          appLayout.current?.openTools();
        },
      }}
    >
      <div id="top-nav">
        <TopNavigation
          identity={{
            href: '/',
            title: Config.applicationName,
            logo: {
              src: Config.logo,
            },
          }}
          utilities={[
            {
              type: 'menu-dropdown',
              text: selectedAccount
                ? `${selectedAccount.account_name}`
                : 'No account',
              iconName: 'share',
              onItemClick: (e) => {
                const acct = accounts.find((a) => a.account_id === e.detail.id);
                if (acct && acct.account_id !== selectedAccount?.account_id) {
                  setSelectedAccount(acct);
                  window.location.reload();
                }
              },
              items: accounts.map((a) => ({
                id: a.account_id,
                text: `${a.account_name} (${a.account_id})`,
                ...(a.account_id === selectedAccount?.account_id && {
                  iconName: 'status-positive' as const,
                }),
              })),
            },
            {
              type: 'menu-dropdown',
              text: `${user?.profile?.['cognito:username']}`,
              iconName: 'user-profile-active',
              onItemClick: (e) => {
                if (e.detail.id === 'signout') {
                  removeUser();
                  signoutRedirect({
                    post_logout_redirect_uri: window.location.origin,
                    extraQueryParams: {
                      redirect_uri: window.location.origin,
                      response_type: 'code',
                    },
                  });
                  clearStaleState();
                }
              },
              items: [{ id: 'signout', text: 'Sign out' }],
            },
          ]}
        />
      </div>
      <CloudscapeAppLayout
        ref={appLayout}
        headerSelector="#top-nav"
        navigation={
          <SideNavigation
            header={{ text: Config.applicationName, href: '/' }}
            activeHref={pathname}
            onFollow={onNavigate}
            items={[
              {
                type: 'section',
                text: 'Overview',
                items: [{ text: 'Dashboard', type: 'link', href: '/' }],
              },
              { type: 'divider' },
              {
                type: 'section',
                text: 'Billing management',
                items: [
                  {
                    text: 'Billing transfer',
                    type: 'link',
                    href: '/partner-dashboard',
                  },
                  {
                    text: 'Pro forma gap analysis',
                    type: 'link',
                    href: '/gap-analysis',
                  },
                ],
              },
              { type: 'divider' },
              {
                type: 'section',
                text: 'Data & reports',
                items: [
                  {
                    text: 'CUR export manager',
                    type: 'link',
                    href: '/cur-manager',
                  },
                  {
                    text: 'Customer reports',
                    type: 'link',
                    href: '/customer-reports',
                  },
                ],
              },
              { type: 'divider' },
              {
                type: 'section',
                text: 'Tools',
                items: [
                  {
                    text: 'Billing assistant',
                    type: 'link',
                    href: '/chat',
                  },
                ],
              },
            ]}
          />
        }
        toolsHide
        content={children}
        {...appLayoutProps}
      />
      <ChatWidget />
    </AppLayoutContext.Provider>
  );
};

export default AppLayout;
