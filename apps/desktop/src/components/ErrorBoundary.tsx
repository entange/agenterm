import { Button, EmptyState } from '@agenterm/ui';
import * as React from 'react';

/**
 * Keeps one broken view from blanking the whole window. The app-level
 * boundary offers a reload; inner boundaries (one per session) let the
 * rest of the control room keep working.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; title?: string; className?: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('agenterm view crashed', error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <EmptyState
        className={this.props.className ?? 'h-full'}
        title={this.props.title ?? 'Something went wrong in this view'}
        detail={error.message}
        action={
          <div className="flex gap-2">
            <Button size="sm" tone="secondary" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button size="sm" tone="quiet" onClick={() => window.location.reload()}>
              Reload window
            </Button>
          </div>
        }
      />
    );
  }
}
