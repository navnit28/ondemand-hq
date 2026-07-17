import React from 'react';

/**
 * STEP 6 — Production hardening: React error boundary.
 * Wraps the message stream, wizard panel and audio components so a render
 * crash in one region never blanks the whole app. Offers a local reset.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    // structured client-side log; no secrets involved
    console.error(`[ui-boundary:${this.props.name || 'region'}]`, error?.message, info?.componentStack?.slice(0, 300));
  }
  render() {
    if (this.state.error) {
      return (
        <div className="boundary" role="alert">
          <div className="boundary__title">This panel hit an error{this.props.name ? ` (${this.props.name})` : ''}.</div>
          <div className="boundary__msg">{String(this.state.error?.message || this.state.error).slice(0, 200)}</div>
          <button className="boundary__reset" onClick={() => this.setState({ error: null })}>Reload panel</button>
        </div>
      );
    }
    return this.props.children;
  }
}
