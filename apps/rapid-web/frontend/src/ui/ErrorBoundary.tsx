import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './primitives/Button';

/**
 * Last resort against a white screen. Reading localStorage THROWS in Safari
 * private browsing, before anything has rendered.
 *
 * Reload rather than silent recovery: a component that threw once will throw
 * again on the same input.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // No telemetry by design — nothing leaves the Mac.
    console.error('rapid-web:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        className="flex h-dvh flex-col items-center justify-center gap-2.5 px-6 py-8 text-center"
        role="alert"
      >
        <h1 className="font-display m-0 text-[22px] font-semibold">Something broke</h1>
        <p className="text-muted m-0 max-w-[34ch] text-sm">
          The page hit an error it could not recover from. Your conversations are stored in this
          browser and were not affected.
        </p>
        <p className="font-mono text-faint m-0 max-w-[40ch] text-xs [overflow-wrap:anywhere]">
          {this.state.error.message}
        </p>
        <Button variant="primary" size="lg" className="mt-1.5" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
