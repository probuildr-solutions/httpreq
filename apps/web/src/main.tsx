import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { ColorSchemeScript, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserHttpRuntime, ElectronHttpRuntime } from '@httpreq/api-client';
import { createBrowserStorage } from '@httpreq/storage';
import { HttpReqApp, httpReqTheme } from '@httpreq/ui';

const bridge = window.httpreq;
const runtime = bridge ? new ElectronHttpRuntime() : new BrowserHttpRuntime();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * Storage is opened before the first render: IndexedDB is asynchronous, and the app would
 * otherwise flash an empty workspace before the real one arrived. The same key/value store backs
 * the browser and the desktop build, so workspaces behave identically on both.
 */
const { repository, history } = await createBrowserStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorSchemeScript defaultColorScheme="auto" />
    <MantineProvider theme={httpReqTheme} defaultColorScheme="auto">
      <Notifications position="bottom-right" />
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <HttpReqApp
            runtime={runtime}
            repository={repository}
            history={history}
            desktop={bridge?.desktop}
            bridge={bridge}
            build={__APP_BUILD__}
            // Development builds never look for updates: they are always "newer".
            checkForUpdates={import.meta.env.PROD}
          />
        </HashRouter>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
