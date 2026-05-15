import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Unregister any stale service workers to ensure fresh code loads
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister();
      console.log('[EvigStudio] Unregistered stale service worker');
    }
  });
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error('[EvigStudio] Root render error', err, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <div
          style={{
            fontFamily: 'system-ui, sans-serif',
            padding: 28,
            maxWidth: 560,
            margin: '0 auto',
            lineHeight: 1.5,
          }}
        >
          <h1 style={{ fontSize: '1.125rem', fontWeight: 700, marginBottom: 12 }}>EvigStudio could not load</h1>
          <pre
            style={{
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#f4f4f5',
              padding: 12,
              borderRadius: 8,
              marginBottom: 16,
            }}
          >
            {this.state.err.message}
          </pre>
          <p style={{ fontSize: 14, color: '#52525b' }}>
            If you opened this app over plain HTTP (for example an IP address like{' '}
            <code style={{ fontSize: 12 }}>http://192.168.x.x</code>), try{' '}
            <strong>HTTPS</strong> or <strong>localhost</strong> instead. Some browsers limit crypto and storage on
            non-secure pages. Open the browser console (F12) for the full stack trace.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) {
  document.body.textContent = 'Missing #root element.';
} else {
  createRoot(rootEl).render(
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>,
  );
}
