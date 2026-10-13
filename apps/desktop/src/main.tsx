import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 1000
    }
  }
});

// Development builds expose the query cache for profiling from devtools.
if (import.meta.env.DEV) (window as unknown as { __agentermQuery?: QueryClient }).__agentermQuery = queryClient;

const host = document.getElementById('root');
if (host !== null) {
  createRoot(host).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary title="agenterm hit an error">
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </React.StrictMode>
  );
}
